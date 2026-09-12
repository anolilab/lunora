/**
 * The `__schedule_outbox` table: durable custody of a deferred
 * `ctx.scheduler.runAfter`/`runAt` between the mutation's COMMIT and the moment
 * the SchedulerDO actually accepts the job.
 *
 * A deferred schedule is buffered until the transaction commits and only then
 * dispatched (see `@lunora/server`'s `deferred-schedules.ts`). Everything between
 * those two points is outside the transaction, so a failure there — the
 * SchedulerDO unreachable, the DO evicted, the isolate killed — leaves writes
 * that are durable and a job that exists nowhere. The mutation's replay-dedup row
 * commits inside the same span, so the client's retry short-circuits on it and is
 * told the mutation succeeded: the job is lost with nothing reported.
 *
 * The row closes that window. It is written while the handler runs — INSIDE the
 * transaction, so it is durable exactly when the writes are and disappears with
 * them on a rollback — and deleted once the scheduler has accepted the job. A row
 * that outlives its dispatch is a job that was promised and not enqueued, and the
 * shard's poll alarm retries it with backoff until it lands or the attempt
 * ceiling parks it.
 *
 * Retries are safe because the job id is decided BEFORE the call (see
 * `resolveScheduleId`): re-dispatching an entry the SchedulerDO already accepted
 * is refused as a duplicate rather than double-scheduled.
 *
 * Extracted as a cohesive unit next to `ctx-db-idempotency.ts`, which it exists
 * to make honest, and it touches the store only through `SqlExec`.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-schedule-outbox" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

const SCHEDULE_OUTBOX_TABLE = "__schedule_outbox";

/** One deferred schedule that has not been confirmed by the SchedulerDO yet. */
interface ScheduleOutboxRow {
    /** How many dispatch attempts have already failed. `0` until the first retry. */
    attempts: number;
    /** The buffered call, JSON-encoded — see {@link ScheduleOutboxEnvelope}. */
    envelopeJson: string;
    /** The job id the caller was already handed, and the id the retry must reuse. */
    id: string;
    /** Wall-clock millis the next retry becomes due. */
    nextAttemptAt: number;
}

/**
 * The buffered `runAfter`/`runAt` call, in the form the retry replays it.
 *
 * `args` is stored WIRE-ENCODED (the same encode `@lunora/scheduler` applies on
 * the way to the DO), so a `bigint`/`ArrayBuffer` argument survives the JSON hop
 * and a value the codec refuses fails inside the transaction rather than after
 * the commit.
 */
interface ScheduleOutboxEnvelope {
    args: unknown;
    options: Record<string, unknown> | undefined;
    target: unknown;

    /**
     * The ABSOLUTE instant the job was asked to fire at — a `runAfter`'s delay is
     * normalised against the clock at buffer time. A delay replayed after an hour
     * in custody would fire an hour late; the retry has to reproduce the fire time
     * the caller asked for, not the wait.
     */
    when: number;
}

/**
 * Durable custody for one shard's deferred schedules — the seam between the
 * buffering facade (`@lunora/server`) and the store that holds the entries
 * (`@lunora/do`). Declared here, beside the table, because both sides depend on
 * this package and neither depends on the other.
 *
 * The two halves land on opposite sides of the COMMIT on purpose. `record` runs
 * while the handler is still inside its transaction, so the entry is durable
 * exactly when the writes are and rolls back with them; `forget` runs after the
 * dispatch settles. What survives is precisely the set of jobs that were promised
 * and not enqueued.
 */
interface ScheduleOutbox {
    /** Release custody — the scheduler has the job, or the window that owned it was dropped. */
    forget: (id: string) => void;

    /**
     * Take custody of one buffered call. Runs INSIDE the transaction, so a throw
     * here rolls the mutation back — which is the right answer, and the only
     * moment at which failing is free.
     *
     * `when` is always the ABSOLUTE instant, even for a `runAfter`: a delay
     * replayed after an hour in custody would fire an hour late, and the retry has
     * to reproduce the fire time the caller asked for, not the wait.
     */
    record: (id: string, envelope: ScheduleOutboxEnvelope) => void;
    /** Ask the host to wake its retry loop — called when a dispatch left entries behind. */
    wake: () => void;
}

/**
 * Create the `__schedule_outbox` table. Created on every shard (empty, and free,
 * until the first deferred schedule) for the same reason `__idempotency` is: a
 * `ctx.scheduler` call needs no schema change to appear, so the table has to
 * exist before the first mutation makes one.
 *
 * `dead` marks an entry that exhausted its attempts: it is no longer retried, and
 * is kept for inspection until {@link trimScheduleOutbox} drops it. The index
 * leads with it so the due-scan reads only live rows.
 */
const migrateScheduleOutbox = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} (
            id TEXT PRIMARY KEY,
            envelope_json TEXT NOT NULL,
            attempts INTEGER NOT NULL,
            next_attempt_at REAL NOT NULL,
            created_at REAL NOT NULL,
            dead INTEGER NOT NULL DEFAULT 0
        )`,
    );

    runDrizzle(
        sql,
        dsql`CREATE INDEX IF NOT EXISTS ${dsql.identifier(`${SCHEDULE_OUTBOX_TABLE}_due`)} ON ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} (dead, next_attempt_at)`,
    );
};

/**
 * Take custody of one buffered schedule. Called from inside the mutation's
 * transaction, so the row commits with the writes and rolls back with them.
 *
 * `INSERT OR REPLACE` rather than `OR IGNORE`: the id is fresh per call except
 * when the caller supplied their own `options.id`, and a re-dispatch under that
 * id must carry the NEW envelope, not resurrect the old one.
 */
const recordScheduleOutbox = (sql: SqlExec, id: string, envelopeJson: string, now: number): void => {
    runDrizzle(
        sql,
        dsql`INSERT OR REPLACE INTO ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} (id, envelope_json, attempts, next_attempt_at, created_at, dead)
            VALUES (${id}, ${envelopeJson}, 0, ${now}, ${now}, 0)`,
    );
};

/**
 * Release custody — the SchedulerDO has the job (or has refused it as a
 * duplicate, which means it already had it). Idempotent, so a settle that runs
 * twice, or a retry racing the original dispatch, is a no-op the second time.
 */
const forgetScheduleOutbox = (sql: SqlExec, id: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} WHERE id = ${id}`);
};

/**
 * The live entries due for a retry attempt at `nowMs`, oldest first so a backlog
 * drains in the order it accumulated. `limit` bounds ONE alarm tick's work; the
 * remainder is picked up by the next tick, which {@link probeScheduleOutbox}
 * arms.
 */
const readDueScheduleOutbox = (sql: SqlExec, nowMs: number, limit: number): ScheduleOutboxRow[] => {
    const rows = runDrizzle<{ attempts: number; envelope_json: string; id: string; next_attempt_at: number }>(
        sql,
        dsql`SELECT id, envelope_json, attempts, next_attempt_at FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)}
            WHERE dead = 0 AND next_attempt_at <= ${nowMs}
            ORDER BY next_attempt_at ASC LIMIT ${limit}`,
    ).toArray();

    return rows.map((row) => {
        return { attempts: row.attempts, envelopeJson: row.envelope_json, id: row.id, nextAttemptAt: row.next_attempt_at };
    });
};

/** Record a failed attempt and push the entry out to `nextAttemptAt`. */
const deferScheduleOutbox = (sql: SqlExec, id: string, attempts: number, nextAttemptAt: number): void => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} SET attempts = ${attempts}, next_attempt_at = ${nextAttemptAt} WHERE id = ${id}`);
};

/**
 * Stop retrying an entry that exhausted its attempts. The row stays — parked, not
 * deleted — so the job that was promised and never enqueued can be found and
 * re-driven by hand; {@link trimScheduleOutbox} is what eventually bounds it.
 */
const parkScheduleOutbox = (sql: SqlExec, id: string, attempts: number): void => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} SET attempts = ${attempts}, dead = 1 WHERE id = ${id}`);
};

/**
 * Everything the poll tier needs to decide what to do, in one indexed pass —
 * because in the steady state (an empty outbox) that pass IS the whole tick.
 *
 * `dueAt` is when the earliest LIVE entry next becomes due, and doubles as the
 * alarm's wake time; `undefined` means nothing is being retried and the tier can
 * stay dormant. `populated` says whether the table holds anything at all,
 * including parked entries — which is what tells the retention sweep it is worth
 * issuing, on a shard whose live entries have all drained.
 */
const probeScheduleOutbox = (sql: SqlExec): { dueAt: number | undefined; populated: boolean } => {
    const rows = runDrizzle<{ due: number | null; total: number }>(
        sql,
        dsql`SELECT MIN(CASE WHEN dead = 0 THEN next_attempt_at END) AS due, COUNT(*) AS total FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)}`,
    ).toArray();

    const row = rows[0];
    const due = row?.due;

    return { dueAt: due ?? undefined, populated: (row?.total ?? 0) > 0 };
};

/**
 * Drop PARKED entries created before `olderThanTs` (millis). Live entries are
 * never trimmed — a job still being retried is not garbage — so the table is
 * bounded in both directions: by the attempt ceiling on one side and by this
 * retention sweep on the other.
 */
const trimScheduleOutbox = (sql: SqlExec, olderThanTs: number): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} WHERE dead = 1 AND created_at < ${olderThanTs}`);
};

export {
    deferScheduleOutbox,
    forgetScheduleOutbox,
    migrateScheduleOutbox,
    parkScheduleOutbox,
    probeScheduleOutbox,
    readDueScheduleOutbox,
    recordScheduleOutbox,
    SCHEDULE_OUTBOX_TABLE,
    trimScheduleOutbox,
};
export type { ScheduleOutbox, ScheduleOutboxEnvelope, ScheduleOutboxRow };
