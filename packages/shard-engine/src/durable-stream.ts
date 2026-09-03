/**
 * Durable streams: the persisted backing store for a `.stream()` procedure
 * declared `durable`.
 *
 * An ordinary stream is a per-socket iterator — the producer is owned by the
 * socket that opened it, so a reload mid-generation loses everything already
 * yielded and cannot be resumed. That is fine for a progress feed and wrong for
 * anything expensive: a model's answer must survive a refresh, and a second tab
 * watching the same run must see the same tokens.
 *
 * A durable stream separates three concerns. **Identity:** a run is keyed by
 * `(functionPath, args)`, so the same call from any socket attaches to the same
 * run rather than starting a second one. **Durability:** every chunk is appended
 * to `__stream_chunks` under a monotonic `seq` before it reaches a socket, so a
 * reconnect replays from the last `seq` the client acknowledged and continues
 * live from there. **Lifetime:** `__stream_runs` records the terminal state, so
 * a client that attaches after the producer finished still gets the full
 * transcript and a `complete` frame instead of hanging.
 *
 * The store is host-neutral (it touches SQLite only through {@link SqlExec});
 * driving the producer and fanning chunks out to attached sockets is the host's
 * job.
 *
 * **Known ceiling.** A run whose producer dies with the DO instance (eviction
 * mid-generation) stays `running` with no live producer. Attaching to one
 * replays the persisted prefix and then fails with `STREAM_INTERRUPTED` rather
 * than silently restarting the handler — re-running a model call would bill
 * twice and duplicate the tail. Resumable-on-the-server producers would need
 * the handler itself to be replay-safe; use `@lunora/workflow` when you need
 * that guarantee today.
 */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

const STREAM_RUNS_TABLE = "__stream_runs";
const STREAM_CHUNKS_TABLE = "__stream_chunks";

/** Terminal and non-terminal states a durable run can be in. */
type DurableStreamStatus = "complete" | "error" | "running";

/** A durable run's header row — everything but the chunks themselves. */
interface DurableStreamRun {
    /** Redacted error message, present only when `status === "error"`. */
    error?: string;
    /** Error code, present only when `status === "error"`. */
    errorCode?: string;
    /** Highest `seq` appended so far; `0` before the first chunk. */
    lastSeq: number;
    /** Wall-clock millis when the run started — drives TTL trimming. */
    startedAt: number;
    status: DurableStreamStatus;
}

/** One persisted chunk, in `seq` order. */
interface DurableStreamChunk {
    /** The wire-encoded chunk payload, JSON-stringified. */
    dataJson: string;
    seq: number;
}

/**
 * Create the durable-stream tables. Both are always present (empty until the
 * first durable stream runs, so a project with none pays nothing) because a
 * durable stream can be declared without a schema migration.
 */
const migrateDurableStreams = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(STREAM_RUNS_TABLE)} (
            run_key TEXT PRIMARY KEY,
            status TEXT NOT NULL,
            last_seq INTEGER NOT NULL DEFAULT 0,
            error_code TEXT,
            error TEXT,
            started_at REAL NOT NULL,
            ttl_ms REAL NOT NULL
        )`,
    );

    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(STREAM_CHUNKS_TABLE)} (
            run_key TEXT NOT NULL,
            seq INTEGER NOT NULL,
            data_json TEXT NOT NULL,
            PRIMARY KEY (run_key, seq)
        )`,
    );
};

/** Read a run header, or `undefined` when the run was never started (or was trimmed). */
const readStreamRun = (sql: SqlExec, runKey: string): DurableStreamRun | undefined => {
    const rows = runDrizzle<{ error: string | null; error_code: string | null; last_seq: number; started_at: number; status: string }>(
        sql,
        dsql`SELECT status, last_seq, error_code, error, started_at FROM ${dsql.identifier(STREAM_RUNS_TABLE)} WHERE run_key = ${runKey} LIMIT 1`,
    ).toArray();

    const row = rows[0];

    if (row === undefined) {
        return undefined;
    }

    return {
        ...(row.error === null ? {} : { error: row.error }),
        ...(row.error_code === null ? {} : { errorCode: row.error_code }),
        lastSeq: row.last_seq,
        startedAt: row.started_at,
        status: row.status as DurableStreamStatus,
    };
};

/**
 * Claim a run for production. Returns `true` when this caller created the row
 * and therefore owns the producer; `false` when a run already exists, in which
 * case the caller attaches to it instead of starting a second handler.
 *
 * The read and the insert are not a race despite being two statements: a DO
 * executes one event at a time and nothing awaits between them, so no second
 * attach can interleave. `RETURNING` would fold them into one statement, but
 * nothing else in the engine relies on it against workerd's SQLite yet.
 */
const claimStreamRun = (sql: SqlExec, runKey: string, startedAt: number, ttlMs: number): boolean => {
    if (readStreamRun(sql, runKey) !== undefined) {
        return false;
    }

    // A fresh claim is a fresh transcript, so the key must start empty. It is not
    // necessarily: a producer whose row a TTL sweep removed mid-run keeps
    // appending under that key, and if its instance dies before the terminal
    // below can clean up, those chunks are still there. `appendStreamChunk` is
    // `INSERT OR IGNORE`, so this run's own chunks at the colliding seqs would be
    // silently dropped and a reconnect would replay the dead run's tail under
    // this run's generation stamp — exactly the splice `decideDurableAttach`'s
    // generation check exists to prevent, arriving through the storage layer.
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(STREAM_CHUNKS_TABLE)} WHERE run_key = ${runKey}`);

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(STREAM_RUNS_TABLE)} (run_key, status, last_seq, started_at, ttl_ms)
             VALUES (${runKey}, ${"running"}, 0, ${startedAt}, ${ttlMs})`,
    );

    return true;
};

/**
 * Drop a run and its chunks outright — the reclaim path.
 *
 * A run is not a cache of an answer: it is the transcript of one execution. When
 * that execution can no longer be attached to (its producer died with the
 * instance) or a caller is asking for a NEW one rather than resuming, the row has
 * to go, or its key stays wedged until the TTL expires.
 */
const deleteStreamRun = (sql: SqlExec, runKey: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(STREAM_CHUNKS_TABLE)} WHERE run_key = ${runKey}`);
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(STREAM_RUNS_TABLE)} WHERE run_key = ${runKey}`);
};

/**
 * Append one chunk. Called before the chunk reaches any socket, so a client that
 * reconnects can always ask for everything after the last `seq` it saw without a
 * gap.
 *
 * Deliberately one statement: the run row's `last_seq` is written once at the
 * terminal instead of per chunk. A token-at-a-time generation is thousands of
 * chunks, and nothing reads `last_seq` mid-run — an attach replays from
 * `__stream_chunks` itself — so the second write was pure cost on the hottest
 * path this feature has.
 */
const appendStreamChunk = (sql: SqlExec, runKey: string, seq: number, dataJson: string): void => {
    runDrizzle(sql, dsql`INSERT OR IGNORE INTO ${dsql.identifier(STREAM_CHUNKS_TABLE)} (run_key, seq, data_json) VALUES (${runKey}, ${seq}, ${dataJson})`);
};

/**
 * Read the persisted chunks after `sinceSeq`, in order. `sinceSeq = 0` replays
 * the whole transcript, which is what a first-time attach to a finished run
 * asks for.
 */
const readStreamChunks = (sql: SqlExec, runKey: string, sinceSeq: number): DurableStreamChunk[] =>
    runDrizzle<{ data_json: string; seq: number }>(
        sql,
        dsql`SELECT seq, data_json FROM ${dsql.identifier(STREAM_CHUNKS_TABLE)} WHERE run_key = ${runKey} AND seq > ${sinceSeq} ORDER BY seq ASC`,
    )
        .toArray()
        .map((row) => {
            return { dataJson: row.data_json, seq: row.seq };
        });

/**
 * Mark a run finished. `errorCode`/`error` are written only for the `error`
 * status.
 *
 * A run whose row is already gone gets its chunks dropped instead.
 * {@link trimStreamRuns} deletes on `startedAt + ttlMs` regardless of status, so
 * a generator that outlives its procedure's `ttlMs` reaches this terminal under
 * a key the sweep has already emptied — and everything it appended afterwards is
 * unreachable by every FUTURE sweep too, because the sweep's chunk delete is
 * scoped by `run_key IN (SELECT … FROM __stream_runs …)`. Recording the terminal
 * would resurrect a run past its own retention; reclaiming the chunks is the
 * honest half, and it is what keeps the next claim under that key from
 * inheriting them through `appendStreamChunk`'s `INSERT OR IGNORE`.
 */
const finishStreamRun = (sql: SqlExec, runKey: string, status: "complete" | "error", lastSeq: number, failure?: { code: string; message: string }): void => {
    if (readStreamRun(sql, runKey) === undefined) {
        runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(STREAM_CHUNKS_TABLE)} WHERE run_key = ${runKey}`);

        return;
    }

    /* eslint-disable unicorn/no-null -- SQL NULL is the value being written: a run that completes must clear its error columns, and `undefined` is not bindable */
    const errorCode = failure?.code ?? null;
    const errorMessage = failure?.message ?? null;
    /* eslint-enable unicorn/no-null */

    runDrizzle(
        sql,
        dsql`UPDATE ${dsql.identifier(STREAM_RUNS_TABLE)}
             SET status = ${status}, last_seq = ${lastSeq}, error_code = ${errorCode}, error = ${errorMessage}
             WHERE run_key = ${runKey}`,
    );
};

/**
 * Drop every run (and its chunks) whose OWN retention window has elapsed.
 *
 * Each run stores the `ttlMs` of the procedure that created it, so the comparison
 * is per row. A shard mixing a 24h chat transcript with a 60s progress stream
 * must not lose the former because the latter happened to trigger the sweep.
 */
const trimStreamRuns = (sql: SqlExec, now: number): void => {
    runDrizzle(
        sql,
        dsql`DELETE FROM ${dsql.identifier(STREAM_CHUNKS_TABLE)} WHERE run_key IN (
            SELECT run_key FROM ${dsql.identifier(STREAM_RUNS_TABLE)} WHERE started_at + ttl_ms < ${now}
        )`,
    );

    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(STREAM_RUNS_TABLE)} WHERE started_at + ttl_ms < ${now}`);
};

export {
    appendStreamChunk,
    claimStreamRun,
    deleteStreamRun,
    finishStreamRun,
    migrateDurableStreams,
    readStreamChunks,
    readStreamRun,
    STREAM_CHUNKS_TABLE,
    STREAM_RUNS_TABLE,
    trimStreamRuns,
};
export type { DurableStreamChunk, DurableStreamRun, DurableStreamStatus };
