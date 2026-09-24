/**
 * The `__lunora_relay_memos` table: a RELAY's durable per-socket cohort
 * baselines, keyed `(connection_id, sub_id)`.
 *
 * A relay delivers an owner's multicast poke to a socket only while that
 * socket's memo sits on the poke's epoch and inside the range it covers. Those
 * memos lived in an instance `WeakMap`, and `ShardDO` builds a fresh
 * `RelayMember` on every wake while the hibernatable sockets and their
 * attachments survive. A relay is evicted freely — `armWebSocketKeepalive`
 * answers client pings from the hibernation auto-response without waking the
 * DO, and a relay receives no other inbound traffic between owner pokes, so
 * idle-and-evicted is the steady state rather than an edge case. The memos were
 * therefore empty on the next poke, every socket was skipped, and the relay
 * still answered 204 — so the owner advanced the cohort frontier and no later
 * poke could reopen the range. Every relayed subscriber froze on stale rows for
 * the life of its socket, silently, in both directions.
 *
 * This is the relay half of what `__shape_poke_cursor` does for the owner's
 * local shape memos and `__lunora_relay_shapes` / `__lunora_relay_binding` do
 * for the rest of the owner's relay state.
 *
 * ## Cleanup
 *
 * A row is dropped on `shape_unsubscribe` and on socket close, both through
 * `RelayMember.releaseRelayShapes`. Neither runs for a SERVER-initiated close
 * (`dropExpiredCredentialSocket` calls `ws.close(4001)`, which the runtime does
 * not answer with a `webSocketClose` dispatch), so {@link deleteAllRelayMemos}
 * is the backstop: the relay clears the table when it loses its last socket,
 * which is the only moment every remaining row is provably dead.
 *
 * Modelled line for line on `ctx-db-shape-poke-cursor.ts`, the owner-side
 * sibling this mirrors, and internal to the relay tier the same way
 * `ctx-db-relay-shapes.ts` is.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-relay-memos" mirrors its siblings "ctx-db-relay-shapes" / "ctx-db-shape-poke-cursor" (the established module naming). */

import { sql as dsql } from "drizzle-orm";

import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { WORKERD_SQLITE_LIMITS } from "./drizzle";

const RELAY_MEMO_TABLE = "__lunora_relay_memos";

/** One socket's cohort baseline for one shape: the checkpoint it was last told it was at, on the CDC epoch that checkpoint belongs to. */
interface RelayShapeMemo {
    cursor: number;
    epoch?: string;
}

/** One socket's baseline for one shape, as {@link writeRelayMemos} takes them. */
interface RelayMemoRow {
    connectionId: string;
    cursor: number;
    epoch: string | undefined;
    subId: string;
}

/**
 * Create the `__lunora_relay_memos` table. Keyed by `(connection_id, sub_id)`,
 * so a re-subscribe upserts rather than duplicating. The `__lunora` prefix
 * keeps it out of the data browser, like `__lunora_relays`.
 */
const migrateRelayMemos = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(RELAY_MEMO_TABLE)} (
            connection_id TEXT NOT NULL,
            sub_id TEXT NOT NULL,
            cursor INTEGER NOT NULL,
            epoch TEXT,
            PRIMARY KEY (connection_id, sub_id)
        )`,
    );
};

/**
 * Every stored memo on this relay, grouped `connectionId → subId → memo`.
 *
 * Unfiltered on purpose. A relay exists by construction only past the promotion
 * threshold (~8 000 subscribers), and the post-eviction wake is the steady state
 * — so hydrating per socket meant thousands of `WHERE connection_id = ?` reads
 * inside one poke handler. One scan of a table whose row count is bounded by
 * this relay's own subscriptions is the same trade `OwnerRelay.ownerRelaySet`
 * already makes for `__lunora_relays`.
 */
const readRelayMemos = (sql: SqlExec): Map<string, Map<string, RelayShapeMemo>> => {
    const rows = runDrizzle<{
        connection_id: string;
        cursor: bigint | number;
        epoch: null | string;
        sub_id: string;
    }>(sql, dsql`SELECT connection_id, sub_id, cursor, epoch FROM ${dsql.identifier(RELAY_MEMO_TABLE)}`).toArray();

    const byConnection = new Map<string, Map<string, RelayShapeMemo>>();

    for (const row of rows) {
        let memos = byConnection.get(row.connection_id);

        if (memos === undefined) {
            memos = new Map<string, RelayShapeMemo>();
            byConnection.set(row.connection_id, memos);
        }

        memos.set(row.sub_id, { cursor: Number(row.cursor), epoch: row.epoch ?? undefined });
    }

    return byConnection;
};

/**
 * Columns each row binds in the batched upsert — the divisor for the
 * bound-parameter budget below.
 */
const RELAY_MEMO_COLUMNS = 4;

/**
 * Upsert many baselines in as few statements as the parameter budget allows.
 *
 * One cohort poke advances every matching socket on the relay, and a relay only
 * exists past the promotion threshold, so a statement each is the shape the
 * owner's `writeShapePokeCursors` was batched to get rid of. Chunked by the
 * shared workerd bound-parameter cap rather than a hand-picked number, because
 * exceeding it is a runtime failure on workerd rather than something the type
 * system catches.
 */
const writeRelayMemos = (sql: SqlExec, rows: ReadonlyArray<RelayMemoRow>): void => {
    const perStatement = Math.floor(WORKERD_SQLITE_LIMITS.boundParams / RELAY_MEMO_COLUMNS);

    for (let start = 0; start < rows.length; start += perStatement) {
        const chunk = rows.slice(start, start + perStatement);
        const values = dsql.join(
            // eslint-disable-next-line unicorn/no-null -- SQL NULL is the value being written for a memo with no epoch; `undefined` is not bindable
            chunk.map((row) => dsql`(${row.connectionId}, ${row.subId}, ${row.cursor}, ${row.epoch ?? null})`),
            dsql`, `,
        );

        runDrizzle(
            sql,
            dsql`INSERT INTO ${dsql.identifier(RELAY_MEMO_TABLE)} (connection_id, sub_id, cursor, epoch) VALUES ${values}
             ON CONFLICT(connection_id, sub_id) DO UPDATE SET cursor = excluded.cursor, epoch = excluded.epoch`,
        );
    }
};

/** Drop the stored memo for a single subscription (on `shape_unsubscribe`). */
const deleteRelayMemo = (sql: SqlExec, connectionId: string, subId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_MEMO_TABLE)} WHERE connection_id = ${connectionId} AND sub_id = ${subId}`);
};

/** Drop every stored memo for a socket (on `webSocketClose`). */
const deleteRelayMemosForConnection = (sql: SqlExec, connectionId: string): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_MEMO_TABLE)} WHERE connection_id = ${connectionId}`);
};

/** Drop every stored memo on this relay — the last-socket backstop for the closes that never dispatch (see the module docblock). */
const deleteAllRelayMemos = (sql: SqlExec): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_MEMO_TABLE)}`);
};

export type { RelayMemoRow, RelayShapeMemo };
export { deleteAllRelayMemos, deleteRelayMemo, deleteRelayMemosForConnection, migrateRelayMemos, readRelayMemos, RELAY_MEMO_TABLE, writeRelayMemos };
