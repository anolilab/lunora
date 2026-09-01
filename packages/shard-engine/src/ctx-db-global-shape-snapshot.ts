/**
 * The `__global_shape_snapshot` table: the durable per-socket membership baseline
 * for `.global()`-table shape subscriptions (Phase 3, latency-tiered poll path).
 *
 * A `.global()` (D1) table has no op-log to diff, so the alarm poll loop re-reads
 * the shape's full membership from the global backend every tick and diffs it
 * against the rows last poked to each socket — emitting only the delta (new key →
 * `insert`, changed value → `update`, vanished key → `delete`). That baseline was
 * originally an in-memory `WeakMap`, which a hibernation eviction silently
 * cleared: on the next alarm wake the diff ran against an *empty* baseline, so a
 * row deleted from D1 while the DO slept produced no `delete` poke and lingered
 * on the client forever (a phantom row). Persisting the baseline here makes the
 * diff survive hibernation — the deleted key is still in the stored snapshot, so
 * the next tick emits its `delete`.
 *
 * Keyed by `(connection_id, sub_id)` — the stable per-socket id minted at upgrade
 * (which rides the hibernatable attachment) plus the client subscription id.
 * `members` is the snapshot serialized as a JSON object `{ [rowKey]: valueJson }`,
 * where `valueJson` is the projected row exactly as it was poked (so the next
 * diff compares wire-identical values).
 *
 * Extracted as a cohesive unit (it touches the store only through `SqlExec`);
 * `ctx-db.ts` re-exports these so existing import sites resolve unchanged.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-global-shape-snapshot" mirrors its parent "ctx-db.ts" (the established public module name). */

import { LunoraError } from "@lunora/errors";
import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";

const GLOBAL_SHAPE_SNAPSHOT_TABLE = "__global_shape_snapshot";

/**
 * Largest `members` blob this table will store, in UTF-16 code units.
 *
 * The whole membership goes in as ONE `JSON.stringify` TEXT value, and the only
 * bound above it was a 50,000-ROW cap — which says nothing about bytes, since a
 * row's projected value is arbitrary width. A wide-enough shape therefore built a
 * value past the Durable Object's per-value SQLite limit, and the write threw
 * from inside the storage layer. Refusing it here instead makes the refusal
 * deterministic and named, so the caller can log the shape that needs narrowing
 * rather than swallowing an opaque storage error.
 *
 * Deliberately well under the platform's own limit: an approximate ceiling that
 * fails early is the point, not one calibrated to the last byte.
 */
const GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS = 1_000_000;

/**
 * Create the `__global_shape_snapshot` table. Keyed by `(connection_id, sub_id)`;
 * `members` holds the JSON-object snapshot of the rows last poked to that socket.
 * Created unconditionally (like `__idempotency`) so a shard that hosts a global
 * shape always has the baseline backing — it costs nothing until the first global
 * shape is seeded.
 */
const migrateGlobalShapeSnapshot = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(GLOBAL_SHAPE_SNAPSHOT_TABLE)} (
            connection_id TEXT NOT NULL,
            sub_id TEXT NOT NULL,
            members TEXT NOT NULL,
            PRIMARY KEY (connection_id, sub_id)
        )`,
    );
};

/**
 * Read a socket's last poked membership for a global shape as a `key → valueJson`
 * map, or `undefined` when NO row is stored. A malformed/non-object blob is
 * treated as an empty membership so a corrupt row degrades rather than throwing.
 *
 * The absent case is `undefined` rather than an empty map because the two mean
 * opposite things to the diff that consumes this. An empty map is a real
 * baseline — "this socket has been poked, and holds nothing" — and diffing
 * against it emits an `insert` per row. A MISSING row means the baseline was
 * lost (the subscription was seeded but its snapshot never persisted, and the
 * in-memory copy went with a hibernation eviction), and diffing against it emits
 * those same inserts while being unable to emit a single `delete` — so a row that
 * left the shape while the DO slept survives on the client forever. Only the
 * caller can tell those apart, and only if this says which one it found.
 */
const readGlobalShapeSnapshot = (sql: SqlExec, connectionId: string, subId: string): Map<string, string> | undefined => {
    const rows = runDrizzle<{ members: string }>(
        sql,
        dsql`SELECT members FROM ${dsql.identifier(GLOBAL_SHAPE_SNAPSHOT_TABLE)} WHERE connection_id = ${connectionId} AND sub_id = ${subId} LIMIT 1`,
    ).toArray();

    const raw = rows[0]?.members;

    if (raw === undefined) {
        return undefined;
    }

    try {
        const parsed: unknown = JSON.parse(raw);

        if (parsed === null || typeof parsed !== "object") {
            return new Map<string, string>();
        }

        return new Map(Object.entries(parsed as Record<string, string>));
    } catch {
        return new Map<string, string>();
    }
};

/**
 * Upsert a socket's membership snapshot for a global shape. The map is serialized
 * to a JSON object; the `(connection_id, sub_id)` primary key keeps one row per
 * subscription. A snapshot past {@link GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS} is
 * refused with a typed error naming the subscription, rather than handed to the
 * storage layer to reject as an opaque per-value limit.
 */
const writeGlobalShapeSnapshot = (sql: SqlExec, connectionId: string, subId: string, snapshot: Map<string, string>): void => {
    const members = JSON.stringify(Object.fromEntries(snapshot));

    if (members.length > GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS) {
        throw new LunoraError(
            "BAD_REQUEST",
            `global shape snapshot for subscription "${subId}" is ${String(members.length)} characters, past the ${String(GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS)}-character cap for one durable baseline row; narrow the shape with a predicate or an RLS read policy`,
        );
    }

    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(GLOBAL_SHAPE_SNAPSHOT_TABLE)} (connection_id, sub_id, members) VALUES (${connectionId}, ${subId}, ${members})
             ON CONFLICT(connection_id, sub_id) DO UPDATE SET members = excluded.members`,
    );
};

/** Drop the stored snapshot for a single subscription (on `shape_unsubscribe`). */
const deleteGlobalShapeSnapshot = (sql: SqlExec, connectionId: string, subId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(GLOBAL_SHAPE_SNAPSHOT_TABLE)} WHERE connection_id = ${connectionId} AND sub_id = ${subId}`);
};

/** Drop every stored snapshot for a socket (on `webSocketClose`). */
const deleteGlobalShapeSnapshotsForConnection = (sql: SqlExec, connectionId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(GLOBAL_SHAPE_SNAPSHOT_TABLE)} WHERE connection_id = ${connectionId}`);
};

export {
    deleteGlobalShapeSnapshot,
    deleteGlobalShapeSnapshotsForConnection,
    GLOBAL_SHAPE_SNAPSHOT_MAX_CHARS,
    GLOBAL_SHAPE_SNAPSHOT_TABLE,
    migrateGlobalShapeSnapshot,
    readGlobalShapeSnapshot,
    writeGlobalShapeSnapshot,
};
