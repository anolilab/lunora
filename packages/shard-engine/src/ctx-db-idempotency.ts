/**
 * The `__idempotency` table: mutation-replay dedup for the DO store.
 *
 * Rows are keyed by `(identity, mutation_id)` so a replayed mutation — the same
 * client-issued id under the same identity — is recognised and short-circuited to
 * its cached result instead of re-executing. Extracted from `ctx-db.ts` as a
 * cohesive unit (it touches the store only through `SqlExec`); the migration
 * creates the table, the dispatch path read/writes it, and a scheduler tick trims
 * it. `ctx-db.ts` re-exports these so existing import sites are unchanged.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-idempotency" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

const IDEMPOTENCY_TABLE = "__idempotency";

/** A previously-committed mutation, keyed by its client-issued id, so a replay returns the cached result instead of re-executing. */
interface IdempotentRecord {
    /** The mutation handler's return value, JSON-stringified (`null` for a void mutation). */
    resultJson: string;
    /** Wall-clock millis when the original mutation committed — drives 24h GC. */
    ts: number;
}

/**
 * Create the `__idempotency` table. Rows are keyed by `(identity, mutation_id)`
 * so a replayed mutation — same client-issued id under the same identity — is
 * recognised and short-circuited to its cached result instead of re-executing.
 * `result_json` is the original handler return value; `ts` drives time-based GC.
 * Created on every shard (cheap, empty until the first id-bearing mutation).
 */
const migrateIdempotency = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(IDEMPOTENCY_TABLE)} (
            identity TEXT NOT NULL,
            mutation_id TEXT NOT NULL,
            result_json TEXT NOT NULL,
            ts REAL NOT NULL,
            PRIMARY KEY (identity, mutation_id)
        )`,
    );
};

/**
 * Look up a committed mutation by `(identity, mutationId)`. Returns the cached
 * record when the mutation has already run (so the dispatch path can return the
 * stored result without re-executing), or `undefined` on first sight.
 */
const readIdempotent = (sql: SqlExec, identity: string, mutationId: string): IdempotentRecord | undefined => {
    const rows = runDrizzle<{ result_json: string; ts: number }>(
        sql,
        dsql`SELECT result_json, ts FROM ${dsql.identifier(IDEMPOTENCY_TABLE)} WHERE identity = ${identity} AND mutation_id = ${mutationId} LIMIT 1`,
    ).toArray();

    const row = rows[0];

    return row === undefined ? undefined : { resultJson: row.result_json, ts: row.ts };
};

/**
 * Record a committed mutation's result. Called inside the same DO transaction as
 * the row writes, so the dedup record is durable iff the writes are — closing the
 * crash window where a write commits but its replay-guard does not. `INSERT OR
 * IGNORE` keeps it a no-op if the key somehow already exists (the dispatch path
 * already read-guarded, so this is belt-and-suspenders).
 */
const writeIdempotent = (sql: SqlExec, identity: string, mutationId: string, resultJson: string, ts: number): void => {
    runDrizzle(
        sql,
        dsql`INSERT OR IGNORE INTO ${dsql.identifier(IDEMPOTENCY_TABLE)} (identity, mutation_id, result_json, ts) VALUES (${identity}, ${mutationId}, ${resultJson}, ${ts})`,
    );
};

/**
 * Drop idempotency records older than `olderThanTs` (millis). Run on a scheduler
 * tick with a 24h cutoff — past any realistic offline-replay window — so the
 * table can't grow unbounded.
 */
const trimIdempotent = (sql: SqlExec, olderThanTs: number): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(IDEMPOTENCY_TABLE)} WHERE ts < ${olderThanTs}`);
};

export { IDEMPOTENCY_TABLE, migrateIdempotency, readIdempotent, trimIdempotent, writeIdempotent };
export type { IdempotentRecord };
