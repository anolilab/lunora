/**
 * The `__client_watermark` table: the per-client custom-mutator watermark for
 * the local-first sync engine (Phase 4).
 *
 * Each row maps an `(identity, client_id)` pair to the highest custom-mutator
 * `mutation_id` the DO has applied for that client. Scoping by the authenticated
 * `identity` (the same fingerprint `__idempotency` uses) keeps the watermark
 * authoritative: a `clientId` is client-supplied and unauthenticated, so without
 * the identity in the key one user could reuse another's `clientId` and suppress
 * their sequence (later seqs classified as already-applied replays). It is a
 * single monotonic counter per pair — the high-watermark the poke protocol
 * echoes back so the client's outbox can drop confirmed pending mutations and
 * TanStack DB can collapse the matching optimistic overlay.
 *
 * Anonymous clients have no authenticated `identity`, so the pair degrades to
 * `("", clientId)` and the `clientId` alone is the principal. The protocol
 * contract is therefore that `clientId` MUST be globally unique per client — the
 * SDK mints it with `crypto.randomUUID` (with a collision-resistant fallback, see
 * `@lunora/client`'s `nextId`), so two anonymous clients never share a watermark
 * namespace. A caller that overrides `clientId` is responsible for the same
 * uniqueness; reusing one across anonymous clients is what the `identity` key
 * guards against once they authenticate.
 *
 * The dispatch contract the watermark enforces (see the DO push path):
 * - `id <= watermark` → already processed (skip, return ok);
 * - `id == watermark + 1` → run the server impl authoritatively and advance the
 * watermark — inside the handler's commit on the transactional path
 * (`commitMutationBookkeeping`, `strict`), so the watermark is durable iff the
 * writes are, and as its own write after they auto-commit on the best-effort
 * one. {@link advanceClientWatermark} spells out why the non-atomic path is
 * still safe; this line used to claim the atomic path unconditionally;
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
 * Create the `__client_watermark` table. Keyed by `(identity, client_id)`;
 * `last_mutation_id` is the monotonic high-watermark of applied custom mutations
 * for that pair. Created alongside `__cdc_log` (custom mutators imply CDC), so
 * non-sync apps pay nothing.
 */
const migrateClientWatermark = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(CLIENT_WATERMARK_TABLE)} (
            identity TEXT NOT NULL,
            client_id TEXT NOT NULL,
            last_mutation_id INTEGER NOT NULL,
            PRIMARY KEY (identity, client_id)
        )`,
    );
};

/**
 * Read a client's current watermark — the highest `mutation_id` applied for
 * `(identity, clientId)`, or `0` when the pair is unseen (so its first mutation
 * is `watermark + 1 == 1`). `identity` is the authenticated user fingerprint
 * (`""` for anonymous), so a reused/spoofed `clientId` under a different identity
 * reads its own zeroed counter and can't suppress the real owner's sequence.
 */
const readClientWatermark = (sql: SqlExec, identity: string, clientId: string): number => {
    const rows = runDrizzle<{ last_mutation_id: number }>(
        sql,
        dsql`SELECT last_mutation_id FROM ${dsql.identifier(CLIENT_WATERMARK_TABLE)} WHERE identity = ${identity} AND client_id = ${clientId} LIMIT 1`,
    ).toArray();

    return rows[0]?.last_mutation_id ?? 0;
};

/**
 * Advance an `(identity, clientId)` pair's watermark to `mutationId`. On the
 * best-effort path this runs as its own write AFTER the mutator's writes
 * auto-commit — NOT atomically with them (the transactional path,
 * `commitMutationBookkeeping(…, { strict })` in `shard-do.ts`, runs it inside
 * the handler's commit instead). The non-atomic case is safe because the gap
 * self-heals: a crash between the handler commit and this advance leaves the
 * watermark behind, so the client's unacked replay re-classifies as `"next"`,
 * re-runs idempotently (the idempotency row dedups the actual write), and
 * re-advances — only ever *replaying*, never skipping or double-applying. The
 * `MAX(...)` upsert keeps the column monotonic even if an out-of-order advance is
 * ever attempted.
 */
const advanceClientWatermark = (sql: SqlExec, identity: string, clientId: string, mutationId: number): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(CLIENT_WATERMARK_TABLE)} (identity, client_id, last_mutation_id) VALUES (${identity}, ${clientId}, ${mutationId})
             ON CONFLICT(identity, client_id) DO UPDATE SET last_mutation_id = MAX(last_mutation_id, excluded.last_mutation_id)`,
    );
};

export { advanceClientWatermark, CLIENT_WATERMARK_TABLE, migrateClientWatermark, readClientWatermark };
