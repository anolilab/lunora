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

import { LunoraError } from "@lunora/errors";
import { isPlainObject } from "@lunora/wire";
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
 * One entry as served by `getScheduleOutbox`. The stored `args` are left out:
 * the operator decides by target, age and state, and the envelope keeps them
 * for the replay.
 */
interface ScheduleOutboxEntry {
    attempts: number;
    createdAt: number;
    /** Whether the call asked for `retry.forever`, which keeps it live past the attempt ceiling. */
    forever: boolean;
    id: string;
    /** When the next attempt is due, or, once `parked`, when the entry parked. */
    nextAttemptAt: number;
    /** Retries stopped: the attempts ran out or the scheduler refused the call. */
    parked: boolean;
    /** The function path or workflow class, or `undefined` when the envelope is unreadable. */
    target: string | undefined;
    /** The instant the job was asked to fire at. */
    when: number | undefined;
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
    /**
     * The schedule-rate budget for `target` (schedule-rate-breaker.ts), asked once per target
     * per dispatch. Returns the instant a schedule to `target` may not fire before, or
     * `undefined` when the call is within budget. Never throws and never refuses: a
     * deferral only ever moves a job later.
     */
    admit: (target: string) => number | undefined;

    /** Release custody — the scheduler has the job, or the window that owned it was dropped. */
    forget: (id: string) => void;

    /**
     * Run one post-commit hand-off under the store's eye and release custody when it lands, so an
     * operator who drops the entry while the call is still awaiting the scheduler is seen, and the
     * job is taken back out when it lands. When absent the facade runs the call and `forget`s the id.
     */
    handOff?: (id: string, run: () => Promise<unknown>) => Promise<void>;

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
 * is kept for inspection until {@link trimScheduleOutbox} drops it. A parked row's
 * `next_attempt_at` holds the instant it parked, which is what the trim ages it by.
 * The index leads with `dead` so the due-scan reads only live rows.
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

    // The admin list pages on (created_at, id), a key that never changes for a row, so a
    // page seeks here instead of scanning and sorting a table that retry.forever grows.
    runDrizzle(
        sql,
        dsql`CREATE INDEX IF NOT EXISTS ${dsql.identifier(`${SCHEDULE_OUTBOX_TABLE}_age`)} ON ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} (created_at, id)`,
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

/**
 * One entry as it stands NOW, if it is still live and due at `nowMs`. A tick reads
 * its batch up front and then awaits the scheduler once per row, so a row it has
 * not reached yet may have been dropped, requeued or parked by an operator since;
 * the attempt re-reads the row it is about to replay instead of trusting the snapshot.
 */
const readDueScheduleOutboxEntry = (sql: SqlExec, id: string, nowMs: number): ScheduleOutboxRow | undefined => {
    const row = runDrizzle<{ attempts: number; envelope_json: string; id: string; next_attempt_at: number }>(
        sql,
        dsql`SELECT id, envelope_json, attempts, next_attempt_at FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)}
            WHERE id = ${id} AND dead = 0 AND next_attempt_at <= ${nowMs}`,
    ).toArray()[0];

    return row === undefined ? undefined : { attempts: row.attempts, envelopeJson: row.envelope_json, id: row.id, nextAttemptAt: row.next_attempt_at };
};

/** Record a failed attempt and push the entry out to `nextAttemptAt`. */
const deferScheduleOutbox = (sql: SqlExec, id: string, attempts: number, nextAttemptAt: number): void => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} SET attempts = ${attempts}, next_attempt_at = ${nextAttemptAt} WHERE id = ${id}`);
};

/**
 * Stop retrying an entry that exhausted its attempts. The row stays — parked, not
 * deleted — so the job that was promised and never enqueued can be found and
 * re-driven by hand; {@link trimScheduleOutbox} is what eventually bounds it.
 *
 * The park instant goes into `next_attempt_at` because the trim must age a
 * parked row from when it parked: a `retry.forever` entry or a re-queued one can
 * be weeks old by `created_at`, and would be trimmed in the tick that parked it.
 */
const parkScheduleOutbox = (sql: SqlExec, id: string, attempts: number, now: number): void => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} SET attempts = ${attempts}, next_attempt_at = ${now}, dead = 1 WHERE id = ${id}`);
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
 * Drop entries PARKED before `olderThanTs` (millis). Live entries are never
 * trimmed — a job still being retried is not garbage. The attempt ceiling bounds
 * live entries under the default policy; a `retry.forever` entry stays live until
 * the scheduler accepts or refuses it.
 */
const trimScheduleOutbox = (sql: SqlExec, olderThanTs: number): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} WHERE dead = 1 AND next_attempt_at < ${olderThanTs}`);
};

/** The target a stored envelope names, for display: a function path or a workflow class. */
const describeTarget = (target: unknown): string | undefined => {
    if (typeof target === "string") {
        return target;
    }

    if (!isPlainObject(target)) {
        return undefined;
    }

    if (typeof target["__lunoraRef"] === "string") {
        return target["__lunoraRef"];
    }

    return typeof target["className"] === "string" ? target["className"] : undefined;
};

/** One list row: the columns plus the three envelope fields {@link toEntry} needs, extracted in SQL. */
interface ScheduleOutboxListRow {
    attempts: number;
    created_at: number;
    dead: number;
    forever: number;
    id: string;
    next_attempt_at: number;
    target: string | number | null;
    target_type: string | null;
    when_ts: number | null;
}

const toEntry = (row: ScheduleOutboxListRow): ScheduleOutboxEntry => {
    let target: unknown;

    if (row.target_type === "text") {
        target = row.target;
    } else if (row.target_type === "object" && typeof row.target === "string") {
        try {
            target = JSON.parse(row.target);
        } catch {
            target = undefined;
        }
    }

    return {
        attempts: row.attempts,
        createdAt: row.created_at,
        forever: row.forever === 1,
        id: row.id,
        nextAttemptAt: row.next_attempt_at,
        parked: row.dead === 1,
        target: describeTarget(target),
        when: typeof row.when_ts === "number" ? row.when_ts : undefined,
    };
};

/** `<created_at>:<id>`. The id is the remainder, since a caller-supplied job id may contain `:`. */
const SCHEDULE_OUTBOX_CURSOR = /^(\d+(?:\.\d+)?):(.+)$/su;

/** Where a page of {@link readScheduleOutbox} ended. */
const toScheduleOutboxCursor = (entry: ScheduleOutboxEntry): string => `${String(entry.createdAt)}:${entry.id}`;

/** `undefined` for a cursor this module did not issue. */
const parseScheduleOutboxCursor = (cursor: string): { createdAt: number; id: string } | undefined => {
    const match = SCHEDULE_OUTBOX_CURSOR.exec(cursor);

    if (match === null) {
        return undefined;
    }

    return { createdAt: Number(match[1]), id: match[2] as string };
};

/**
 * One page of entries, oldest first, live and parked alike. Keyset-paged on
 * `(created_at, id)`, which a row keeps for its whole life: parking, requeueing or
 * deleting an entry between two page reads can neither hide a row nor repeat one,
 * and every parked entry stays reachable behind any number of live ones.
 *
 * The envelope is never read whole: `target`, `when` and `retry.forever` are
 * extracted in SQL, so a page does not hold every stored `args` blob in memory.
 * An unreadable envelope still yields an entry, since the operator has to be
 * able to see and drop it.
 */
const readScheduleOutbox = (sql: SqlExec, limit: number, cursor?: string): { entries: ScheduleOutboxEntry[]; nextCursor: string | undefined } => {
    const after = cursor === undefined ? undefined : parseScheduleOutboxCursor(cursor);

    if (cursor !== undefined && after === undefined) {
        throw new LunoraError("BAD_REQUEST", `getScheduleOutbox: malformed cursor ${JSON.stringify(cursor)}`);
    }

    const where = after === undefined ? dsql`` : dsql`WHERE (created_at, id) > (${after.createdAt}, ${after.id})`;
    // One row past the page says whether another page exists without a COUNT.
    // NULL for malformed JSON, and every JSON function maps NULL to NULL instead of raising.
    const env = dsql`(CASE WHEN json_valid(envelope_json) THEN envelope_json END)`;
    const rows = runDrizzle<ScheduleOutboxListRow>(
        sql,
        dsql`SELECT id, attempts, next_attempt_at, created_at, dead,
            CASE WHEN json_type(${env}) = 'object' THEN json_type(${env}, '$.target') END AS target_type,
            CASE WHEN json_type(${env}) = 'object' AND json_type(${env}, '$.target') IN ('text', 'object') THEN json_extract(${env}, '$.target') END AS target,
            CASE WHEN json_type(${env}) = 'object' AND json_type(${env}, '$.when') IN ('integer', 'real') THEN json_extract(${env}, '$.when') END AS when_ts,
            CASE WHEN json_type(${env}) = 'object' AND json_type(${env}, '$.options.retry.forever') = 'true' THEN 1 ELSE 0 END AS forever
            FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)}
            ${where} ORDER BY created_at ASC, id ASC LIMIT ${limit + 1}`,
    ).toArray();
    const entries = rows.slice(0, limit).map((row) => toEntry(row));
    const last = entries.at(-1);

    return { entries, nextCursor: rows.length > limit && last !== undefined ? toScheduleOutboxCursor(last) : undefined };
};

/**
 * What a drop needs to know about the row it is about to remove, captured before it awaits the
 * scheduler: whether the row is parked, and a version that changes when the id is recorded anew.
 * An id alone cannot say "the same entry": a mutation may schedule a new job under the same explicit
 * id while a drop is awaiting, and `INSERT OR REPLACE` gives that row a new `created_at` and envelope.
 */
const readScheduleOutboxState = (sql: SqlExec, id: string): { parked: boolean; version: string } | undefined => {
    const row = runDrizzle<{ created_at: number; dead: number; envelope_json: string }>(
        sql,
        dsql`SELECT created_at, envelope_json, dead FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} WHERE id = ${id}`,
    ).toArray()[0];

    return row === undefined ? undefined : { parked: row.dead === 1, version: `${String(row.created_at)}:${row.envelope_json}` };
};

const hasScheduleOutboxEntry = (sql: SqlExec, id: string): boolean =>
    runDrizzle<{ id: string }>(sql, dsql`SELECT id FROM ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} WHERE id = ${id}`).toArray().length > 0;

/**
 * Put an entry back on the retry ladder from its first rung, due at `now`. The
 * way back from a park, and the way to skip a long backoff once the scheduler is
 * known to be healthy again.
 */
const requeueScheduleOutbox = (sql: SqlExec, id: string, now: number): boolean => {
    if (!hasScheduleOutboxEntry(sql, id)) {
        return false;
    }

    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(SCHEDULE_OUTBOX_TABLE)} SET attempts = 0, next_attempt_at = ${now}, dead = 0 WHERE id = ${id}`);

    return true;
};

/**
 * Drop an entry for good, live or parked: the way to cancel a job the scheduler
 * never accepted, which `ctx.scheduler.cancel` cannot reach.
 */
const dropScheduleOutbox = (sql: SqlExec, id: string): boolean => {
    if (!hasScheduleOutboxEntry(sql, id)) {
        return false;
    }

    forgetScheduleOutbox(sql, id);

    return true;
};

export {
    deferScheduleOutbox,
    dropScheduleOutbox,
    forgetScheduleOutbox,
    hasScheduleOutboxEntry,
    migrateScheduleOutbox,
    parkScheduleOutbox,
    probeScheduleOutbox,
    readDueScheduleOutbox,
    readDueScheduleOutboxEntry,
    readScheduleOutbox,
    readScheduleOutboxState,
    recordScheduleOutbox,
    requeueScheduleOutbox,
    SCHEDULE_OUTBOX_TABLE,
    trimScheduleOutbox,
};
export type { ScheduleOutbox, ScheduleOutboxEntry, ScheduleOutboxEnvelope, ScheduleOutboxRow };
