/**
 * The `__shape_poke_cursor` table: the durable per-socket poke baseline for
 * op-log-backed shape subscriptions (plan 326).
 *
 * `shapeMemos` on `ShardDO` — the `__cdc_log` cursor each shape's view has
 * been poked through — was originally an in-memory-only `WeakMap`. A
 * hibernation eviction (the steady state for an idle shape socket, since the
 * keepalive deliberately lets idle sockets hibernate) silently clears it, so
 * the first write after every wake fell back to a literal `0` instead of the
 * true baseline: `buildShapeDiff` then re-scans the ENTIRE retained
 * `__cdc_log` for that table and re-runs a membership probe over every
 * touched row, no matter how long the log has grown — a real,
 * worsening-over-time cost cliff, not a one-time cold start.
 *
 * These rows now serve a second purpose: they are the shape-subscriber input to
 * the op-log retention floor ({@link minShapePokeCursor}), which is what lets
 * `ShardDO`'s sweep bound the log's growth without ever compacting a range a
 * live subscription has not been poked through.
 *
 * Persisting the baseline here makes it survive hibernation exactly like
 * `__global_shape_snapshot` does for `.global()`-table shapes: keyed by
 * `(connection_id, sub_id)`, written alongside the in-memory memo on every
 * delivered poke, read back on a cold-memo miss before falling further back
 * to the attachment's subscribe-time `sinceSeq` and finally `0`. The
 * direction matters — a baseline that is too HIGH silently drops rows, so
 * every fallback in that chain only ever degrades downward.
 *
 * Extracted as a cohesive unit (it touches the store only through `SqlExec`),
 * modelled line for line on `ctx-db-global-shape-snapshot.ts`.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-shape-poke-cursor" mirrors its sibling "ctx-db-global-shape-snapshot" (the established public module naming). */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { WORKERD_SQLITE_LIMITS } from "./drizzle";

const SHAPE_POKE_CURSOR_TABLE = "__shape_poke_cursor";

/**
 * Create the `__shape_poke_cursor` table. Keyed by `(connection_id, sub_id)`;
 * `cursor` holds the `__cdc_log` seq this shape's view has been poked through.
 * Created alongside the CDC log/epoch (gated the same way, `options.cdc`)
 * since an op-log-backed shape cannot exist without CDC enabled.
 */
const migrateShapePokeCursor = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} (
            connection_id TEXT NOT NULL,
            sub_id TEXT NOT NULL,
            cursor INTEGER NOT NULL,
            PRIMARY KEY (connection_id, sub_id)
        )`,
    );
};

/**
 * Read a socket's stored poke-baseline cursor for a shape, or `undefined`
 * when none is stored (an unseen subscription, or a row that predates this
 * table).
 */
const readShapePokeCursor = (sql: SqlExec, connectionId: string, subId: string): number | undefined => {
    const rows = runDrizzle<{ cursor: number }>(
        sql,
        dsql`SELECT cursor FROM ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} WHERE connection_id = ${connectionId} AND sub_id = ${subId} LIMIT 1`,
    ).toArray();

    return rows[0]?.cursor;
};

/**
 * Upsert a socket's poke-baseline cursor for a shape. The `(connection_id,
 * sub_id)` primary key keeps one row per subscription; called alongside the
 * in-memory `shapeMemos` write on every delivered poke, never on a
 * computed-but-unsent diff.
 */
const writeShapePokeCursor = (sql: SqlExec, connectionId: string, subId: string, cursor: number): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} (connection_id, sub_id, cursor) VALUES (${connectionId}, ${subId}, ${cursor})
             ON CONFLICT(connection_id, sub_id) DO UPDATE SET cursor = excluded.cursor`,
    );
};

/** One socket's poke baseline for one shape, as {@link writeShapePokeCursors} takes them. */
interface ShapePokeCursorRow {
    connectionId: string;
    cursor: number;
    subId: string;
}

/**
 * Columns each row binds in the batched upsert — the divisor for the
 * bound-parameter budget below.
 */
const SHAPE_POKE_CURSOR_COLUMNS = 3;

/**
 * Upsert many poke baselines in as few statements as the parameter budget allows.
 *
 * One write-flush pokes every subscribed socket, and each delivered poke recorded
 * its baseline with its own statement — so a shape watched by 500 sockets issued
 * 500 upserts for one write. Batching turns that into ceil(500 / 33) statements
 * against the same rows.
 *
 * Chunked by the shared workerd bound-parameter cap rather than a hand-picked
 * number, because exceeding it is a runtime failure on workerd (and `runSql`'s
 * backstop refuses it) rather than something the type system catches.
 *
 * Rows are upserted in the order given; a duplicate `(connection_id, sub_id)`
 * within one call would resolve last-write-wins, which is what the caller's own
 * "cursor only advances" invariant already relies on.
 */
const writeShapePokeCursors = (sql: SqlExec, rows: ReadonlyArray<ShapePokeCursorRow>): void => {
    const perStatement = Math.floor(WORKERD_SQLITE_LIMITS.boundParams / SHAPE_POKE_CURSOR_COLUMNS);

    for (let start = 0; start < rows.length; start += perStatement) {
        const chunk = rows.slice(start, start + perStatement);
        const values = dsql.join(
            chunk.map((row) => dsql`(${row.connectionId}, ${row.subId}, ${row.cursor})`),
            dsql`, `,
        );

        runDrizzle(
            sql,
            dsql`INSERT INTO ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} (connection_id, sub_id, cursor) VALUES ${values}
             ON CONFLICT(connection_id, sub_id) DO UPDATE SET cursor = excluded.cursor`,
        );
    }
};

/**
 * The lowest cursor any stored shape subscription has been poked through, or
 * `undefined` when none is stored.
 *
 * This is the op-log retention floor's shape-subscriber input: a sweep must not
 * compact or delete a range that a live subscription has yet to be told about,
 * and this row set is the only place those positions are durably recorded. An
 * empty table returns `undefined` — "no shape subscriber constrains the sweep" —
 * which is different from `0`, the answer that would pin the floor to the very
 * bottom of the log forever.
 */
const minShapePokeCursor = (sql: SqlExec): number | undefined => {
    const rows = runDrizzle<{ cursor: null | number }>(sql, dsql`SELECT MIN(cursor) AS cursor FROM ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)}`).toArray();

    return rows[0]?.cursor ?? undefined;
};

/** Drop the stored cursor for a single subscription (on `shape_unsubscribe`). */
const deleteShapePokeCursor = (sql: SqlExec, connectionId: string, subId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} WHERE connection_id = ${connectionId} AND sub_id = ${subId}`);
};

/** Drop every stored cursor for a socket (on `webSocketClose`). */
const deleteShapePokeCursorsForConnection = (sql: SqlExec, connectionId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(SHAPE_POKE_CURSOR_TABLE)} WHERE connection_id = ${connectionId}`);
};

export type { ShapePokeCursorRow };
export {
    deleteShapePokeCursor,
    deleteShapePokeCursorsForConnection,
    migrateShapePokeCursor,
    minShapePokeCursor,
    readShapePokeCursor,
    SHAPE_POKE_CURSOR_TABLE,
    writeShapePokeCursor,
    writeShapePokeCursors,
};
