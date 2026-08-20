/**
 * The `__lunora_relay_shapes` table: the durable relay-shape registry an owner
 * multicasts from.
 *
 * The owner's cohort registry and its per-socket proxies were in-memory `Map`s.
 * That is survivable for state a socket re-establishes on reconnect — but an
 * owner in relay mode holds NO sockets of its own (every subscriber sits on a
 * relay), so it is freely evictable between writes and nothing wakes it except
 * the next mutation. Losing the maps there is silent and total: the multicast
 * returns at its empty-registry guard, every relayed shape subscriber stops
 * receiving deltas for every future write, and the only repair is each client
 * happening to reconnect. Nothing logs, nothing retries, nothing notices.
 *
 * These rows carry the same second duty as `__shape_poke_cursor` does for local
 * sockets: they are the relayed-subscriber input to the op-log retention floor
 * (`OwnerRelay.minShapeCursor` reads it off the registry they rehydrate), so a
 * changelog sweep can bound the log without deleting a range the next relayed
 * diff still has to read. An owner that has just been evicted is exactly when
 * that floor mattered most and, before this table, exactly when it was
 * `undefined`.
 *
 * ## Cost
 *
 * One upsert per registration (the seed path — a socket subscribing, not a
 * write) and one cursor update per shape per flush that actually produces a
 * poke. The local path already pays a `__shape_poke_cursor` write per
 * `(connection, subscription)` per delivered poke; a cohort row is one write for
 * a whole relay cohort, so the relayed path stays strictly cheaper per
 * subscriber than the path it mirrors.
 *
 * ## Cleanup
 *
 * Rows are dropped when their relay detaches (its last socket closed) and the
 * whole table is cleared when the relay set empties — see
 * `OwnerRelay.removeRelayFromSet`. That is the only reclamation, deliberately:
 * a row for a subscription that has gone away pins the retention floor at its
 * cursor, but every heuristic that would guess at staleness (an age cut-off, a
 * cursor that hasn't moved) trades a bounded leak for a silent delete of a live
 * subscriber's range. The leak is bounded by relay lifetime; the delete would
 * be unbounded and invisible.
 *
 * Modelled line for line on `ctx-db-shape-poke-cursor.ts`, its local-path
 * sibling.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-relay-shapes" mirrors its sibling "ctx-db-shape-poke-cursor" (the established public module naming). */

import { sql as dsql } from "drizzle-orm";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import type { SubscriptionIdentity } from "./types";

const RELAY_SHAPES_TABLE = "__lunora_relay_shapes";

/** SQL has no `undefined`: a cohort row's relay/connection columns are genuinely NULL, and binding `undefined` is a driver error rather than a NULL. */
// eslint-disable-next-line unicorn/no-null -- the bound value for an absent column; see above
const SQL_NULL = null;

/**
 * One registered relayed shape. A COHORT row (relay-uniform: one delta is
 * correct for every subscriber) leaves `connectionId`/`relayIndex`/`identity`
 * absent — it belongs to the whole relay set. A PROXY row (identity-scoped)
 * carries all three, since its delta is computed under that one socket's
 * identity and addressed to that one connection.
 */
interface RelayShapeRow {
    args: Record<string, unknown>;
    connectionId?: string;
    cursor: number;
    identity?: SubscriptionIdentity;
    /** The registry key: the `(name, args)` routing key for a cohort row, `relayIndex:connectionId:subId` for a proxy row. */
    key: string;
    name: string;
    relayIndex?: number;
}

/**
 * Create the `__lunora_relay_shapes` table. Keyed by the registry key, so a
 * re-subscribe upserts rather than duplicating. Created alongside the CDC
 * log/epoch (gated the same way, `options.cdc`) since a relayed op-log shape
 * cannot exist without CDC enabled — and the `__lunora` prefix keeps it out of
 * the data browser, like `__lunora_relays`.
 */
const migrateRelayShapes = (sql: SqlExec): void => {
    runDrizzle(
        sql,
        dsql`CREATE TABLE IF NOT EXISTS ${dsql.identifier(RELAY_SHAPES_TABLE)} (
            key TEXT PRIMARY KEY,
            relay_idx INTEGER,
            connection_id TEXT,
            name TEXT NOT NULL,
            args TEXT NOT NULL,
            identity TEXT NOT NULL,
            cursor INTEGER NOT NULL
        )`,
    );
};

/** The stored column shape, before the JSON/wire columns are decoded back into a {@link RelayShapeRow}. */
interface StoredRelayShape {
    args: string;
    connection_id: null | string;
    cursor: bigint | number;
    identity: string;
    key: string;
    name: string;
    relay_idx: bigint | null | number;
}

/**
 * Every registered relayed shape, for an owner rehydrating its registry after
 * an eviction.
 *
 * `args` round-trip through the wire codec, not bare JSON: a shape argument can
 * be a `bigint`/`Date`/`Uint8Array`, and `JSON.stringify` of a `bigint` throws
 * outright — the same reason the args are wire-encoded before they cross the
 * owner↔relay hop.
 */
const readRelayShapes = (sql: SqlExec): RelayShapeRow[] => {
    const rows = runDrizzle<StoredRelayShape>(
        sql,
        dsql`SELECT key, relay_idx, connection_id, name, args, identity, cursor FROM ${dsql.identifier(RELAY_SHAPES_TABLE)}`,
    ).toArray();

    return rows.map((row) => {
        return {
            args: decodeWire(JSON.parse(row.args)) as Record<string, unknown>,
            connectionId: row.connection_id ?? undefined,
            cursor: Number(row.cursor),
            identity: JSON.parse(row.identity) as SubscriptionIdentity,
            key: row.key,
            name: row.name,
            relayIndex: row.relay_idx === null ? undefined : Number(row.relay_idx),
        };
    });
};

/** Upsert a shape registration. Called on the seed path, once per `(name, args)` cohort or per relayed socket subscription. */
const writeRelayShape = (sql: SqlExec, row: RelayShapeRow): void => {
    runDrizzle(
        sql,
        dsql`INSERT INTO ${dsql.identifier(RELAY_SHAPES_TABLE)} (key, relay_idx, connection_id, name, args, identity, cursor)
             VALUES (${row.key}, ${row.relayIndex ?? SQL_NULL}, ${row.connectionId ?? SQL_NULL}, ${row.name}, ${JSON.stringify(encodeWire(row.args))}, ${JSON.stringify(row.identity ?? {})}, ${row.cursor})
             ON CONFLICT(key) DO UPDATE SET
                relay_idx = excluded.relay_idx,
                connection_id = excluded.connection_id,
                name = excluded.name,
                args = excluded.args,
                identity = excluded.identity,
                cursor = excluded.cursor`,
    );
};

/**
 * Move a registration's cursor. Written on the same statement-run as the
 * in-memory advance (and its rewind), so a rehydrated registry resumes from the
 * frontier the live one held rather than replaying — or skipping — a range.
 */
const writeRelayShapeCursor = (sql: SqlExec, key: string, cursor: number): void => {
    runDrizzle(sql, dsql`UPDATE ${dsql.identifier(RELAY_SHAPES_TABLE)} SET cursor = ${cursor} WHERE key = ${key}`);
};

/** Drop every proxy row belonging to one relay (on `relay_detach` — its last socket closed, so its per-socket proxies are dead). Cohort rows have no `relay_idx` and are untouched. */
const deleteRelayShapesForRelay = (sql: SqlExec, relayIndex: number): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_SHAPES_TABLE)} WHERE relay_idx = ${relayIndex}`);
};

/** Drop every registration (on full drain — the relay set is empty, so no relayed subscriber exists to strand). */
const deleteAllRelayShapes = (sql: SqlExec): void => {
    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_SHAPES_TABLE)}`);
};

export type { RelayShapeRow };
export { deleteAllRelayShapes, deleteRelayShapesForRelay, migrateRelayShapes, readRelayShapes, RELAY_SHAPES_TABLE, writeRelayShape, writeRelayShapeCursor };
