/**
 * The `__client_watermark` table: the per-client custom-mutator watermark for
 * the local-first sync engine (Phase 4).
 *
 * Each row maps a stable `client_id` to the highest custom-mutator `mutation_id`
 * the DO has applied for that client. Unlike `__idempotency` (which is keyed
 * dedup over `(identity, mutation_id)` and stores cached results), this is a
 * single monotonic counter per client — the high-watermark the poke protocol
 * echoes back so the client's outbox can drop confirmed pending mutations and
 * TanStack DB can collapse the matching optimistic overlay.
 *
 * The dispatch contract the watermark enforces (see the DO push path):
 * - `id &lt;= watermark` → already processed (skip, return ok);
 * - `id == watermark + 1` → run the server impl authoritatively and advance the
 * watermark **in the same transaction** as the writes;
 * - `id > watermark + 1` → an out-of-order gap; the batch halts so the client
 * resends from `watermark + 1`.
 *
 * Extracted as a cohesive unit (it touches the store only through `SqlExec`);
 * `ctx-db.ts` re-exports these so existing import sites resolve unchanged.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-client-watermark" mirrors its parent "ctx-db.ts" (the established public module name). */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

const CLIENT_WATERMARK_TABLE = "__client_watermark";

/**
 * Create the `__client_watermark` table. Keyed by `client_id`; `last_mutation_id`
 * is the monotonic high-watermark of applied custom mutations for that client.
 * Created alongside `__cdc_log` (custom mutators imply CDC), so non-sync apps
 * pay nothing.
 */
const migrateClientWatermark = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(CLIENT_WATERMARK_TABLE)} (
            client_id TEXT PRIMARY KEY,
            last_mutation_id INTEGER NOT NULL
        )`,
    );
};

/**
 * Read a client's current watermark — the highest `mutation_id` applied for
 * `clientId`, or `0` when the client is unseen (so its first mutation is
 * `watermark + 1 == 1`).
 */
const readClientWatermark = (sql: SqlExec, clientId: string): number => {
    const rows = runDrizzle<{ last_mutation_id: number }>(
        sql,
        dsql`SELECT last_mutation_id FROM ${dsql.identifier(CLIENT_WATERMARK_TABLE)} WHERE client_id = ${clientId} LIMIT 1`,
    ).toArray();

    return rows[0]?.last_mutation_id ?? 0;
};

/**
 * Advance a client's watermark to `mutationId`. Called inside the same DO
 * transaction as the mutator's writes, so the watermark is durable iff the
 * writes are — a crash between the write and the advance can only *replay* the
 * mutation (caught next time by `id &lt;= watermark`), never skip it. The
 * `MAX(...)` upsert keeps the column monotonic even if an out-of-order advance
 * is ever attempted.
 */
const advanceClientWatermark = (sql: SqlExec, clientId: string, mutationId: number): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(CLIENT_WATERMARK_TABLE)} (client_id, last_mutation_id) VALUES (${clientId}, ${mutationId})
             ON CONFLICT(client_id) DO UPDATE SET last_mutation_id = MAX(last_mutation_id, excluded.last_mutation_id)`,
    );
};

export { advanceClientWatermark, CLIENT_WATERMARK_TABLE, migrateClientWatermark, readClientWatermark };
