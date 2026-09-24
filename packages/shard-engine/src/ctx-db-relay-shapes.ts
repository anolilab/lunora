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
 * poke. Both are per COHORT, not per subscriber, and that is where this table's
 * saving over the local path's `__shape_poke_cursor` ends: the relay receiving
 * the poke still writes a `__lunora_relay_memos` row per
 * `(connection, subscription)` it advances, so the relayed path pays the local
 * path's per-subscriber write PLUS the owner's cohort row — moved off the owner
 * onto the relay, which is the point of the tier, but not removed.
 *
 * The open question is whether the relay's per-socket baselines could be a
 * per-cohort row too. Nothing in the delivery rule needs per-socket granularity
 * for a relay-UNIFORM shape; what stops it today is that sockets on one relay
 * join at different cursors, so a single cohort baseline would either re-poke
 * or skip whichever half is not at it. Not attempted here.
 *
 * ## Cleanup
 *
 * A PROXY row is dropped when its socket unsubscribes or closes (the relay
 * sends `relay_shape_unsubscribe`, see `relay.ts`), when its relay detaches, and
 * when the relay set empties. The per-socket signal is the load-bearing one:
 * `connectionId` is minted fresh per upgrade, so tying reclamation to relay
 * lifetime — as this table first did — leaks a permanent row per connection on
 * a relay that stays up, and each one pins the op-log retention floor at its
 * cursor (`OwnerRelay.minShapeCursor` is a min over the registry). A single
 * orphan on a quiet table holds `__cdc_log` retention forever while the
 * operator's retention setting appears to do nothing at all.
 *
 * COHORT rows have no socket to key on — one row serves the whole relay set —
 * so they are still reclaimed only on detach / full drain. Their count is
 * bounded by the app's distinct relayed shapes rather than by traffic, which is
 * the bound the per-connection rows never had.
 *
 * No staleness heuristic is used for either: an age cut-off or a cursor that
 * hasn't moved would trade a bounded leak for a silent delete of a live
 * subscriber's range.
 *
 * Modelled line for line on `ctx-db-shape-poke-cursor.ts`, its local-path
 * sibling.
 */

/* eslint-disable unicorn/prevent-abbreviations -- "ctx-db-relay-shapes" mirrors its sibling "ctx-db-shape-poke-cursor" (the established public module naming). */

import { sql as dsql } from "drizzle-orm";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import type { SqlExec } from "./ctx-db";
import { runDrizzle } from "./do-exec";
import { relayProxyKey } from "./relay";
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
 * The JSON-column codec this table's two structured columns share.
 *
 * Named as a pair, and used as a pair, because the halves living apart is how
 * this module drifted once already: `args` went through the wire codec while
 * `identity` went through bare JSON, and nothing structural said they had to
 * agree. Mirrors `encodeDocJson`/`decodeDocJson` in `do-sql.ts`, which exists
 * for the same reason.
 */
const encodeColumn = (value: unknown): string => JSON.stringify(encodeWire(value));

/** The read half of {@link encodeColumn}. */
const decodeColumn = (raw: string): unknown => decodeWire(JSON.parse(raw));

/**
 * Every registered relayed shape, for an owner rehydrating its registry after
 * an eviction.
 *
 * Both structured columns go through {@link encodeColumn}/{@link decodeColumn}
 * rather than bare JSON. For `args` that is load-bearing today: they arrive
 * already wire-encoded from the relay, and a `bigint` would make
 * `JSON.stringify` throw outright.
 *
 * For `identity` it is consistency rather than a live bug, and the distinction
 * is worth recording. `identity` is the claim set RLS resolves against, so a
 * `Date` claim silently becoming a string WOULD be an authorization divergence —
 * but claims reach a shard only through the `x-lunora-identity` header, which is
 * itself `JSON.stringify`d (`shared/identity-header.ts`), so a `bigint` claim
 * already throws at the worker and a `Date` claim is already an ISO string
 * before anything here sees it.
 *
 * The transport half is also still asymmetric: `seedRelayShape` wire-encodes
 * `args` across the relay→owner hop and forwards `identity` raw
 * (`relay-hub.ts`), with no matching decode. Closing that is a wire-format
 * change on the relay path and is deliberately NOT done here — this column pair
 * is simply no longer the place the asymmetry lives.
 */
const readRelayShapes = (sql: SqlExec): RelayShapeRow[] => {
    const rows = runDrizzle<StoredRelayShape>(
        sql,
        dsql`SELECT key, relay_idx, connection_id, name, args, identity, cursor FROM ${dsql.identifier(RELAY_SHAPES_TABLE)}`,
    ).toArray();

    return rows.map((row) => {
        return {
            args: decodeColumn(row.args) as Record<string, unknown>,
            connectionId: row.connection_id ?? undefined,
            cursor: Number(row.cursor),
            identity: decodeColumn(row.identity) as SubscriptionIdentity,
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
             VALUES (${row.key}, ${row.relayIndex ?? SQL_NULL}, ${row.connectionId ?? SQL_NULL}, ${row.name}, ${encodeColumn(row.args)}, ${encodeColumn(row.identity ?? {})}, ${row.cursor})
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

/**
 * Drop the proxy rows one relay socket owns — `subId` scopes it to a single
 * subscription, and omitting it covers every shape the connection held (its
 * socket closed). The per-socket reclamation the table lacked: a relay that
 * stays up across many short-lived sockets otherwise accumulates one permanent
 * row per connection, each one pinning the op-log retention floor.
 */
const deleteRelayShapesForConnection = (sql: SqlExec, relayIndex: number, connectionId: string, subId?: string): void => {
    const scope = subId === undefined ? dsql`` : dsql` AND key = ${relayProxyKey(relayIndex, connectionId, subId)}`;

    runDrizzle(sql, dsql`DELETE FROM ${dsql.identifier(RELAY_SHAPES_TABLE)} WHERE relay_idx = ${relayIndex} AND connection_id = ${connectionId}${scope}`);
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
export {
    deleteAllRelayShapes,
    deleteRelayShapesForConnection,
    deleteRelayShapesForRelay,
    migrateRelayShapes,
    readRelayShapes,
    RELAY_SHAPES_TABLE,
    writeRelayShape,
    writeRelayShapeCursor,
};
