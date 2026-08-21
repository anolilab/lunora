/**
 * Turn-key incremental-sync source helpers for warehouse connectors
 * (Fivetran custom functions, Airbyte incremental sources).
 *
 * The runtime's admin `/_lunora/admin/connector/sync` endpoint returns a
 * {@link ConnectorSyncPage}: a flat list of change records since an opaque
 * cursor, a `nextCursor` to resume from, and a `hasMore` flag. These helpers
 * reshape that page into the response envelopes the two ecosystems expect, so a
 * connector wrapper stays a few lines.
 *
 * {@link toFivetranResponse} produces the `{ state, insert, update, delete,
 * hasMore, schema }` object a Fivetran connector function returns from its
 * handler. {@link toAirbyteMessages} produces an ordered array of Airbyte
 * protocol messages (a `RECORD` per row, a trailing `STATE` carrying the cursor),
 * the line-delimited stream an Airbyte incremental source emits.
 *
 * Both consume the SAME page, so a single endpoint feeds either ecosystem.
 *
 * Shard admin RPCs hand docs over in wire form (`encodeWire` tags for bigint /
 * bytes), so both formatters decode each doc and map it to warehouse-portable
 * JSON before it reaches third-party output — see {@link toPortableDocument}.
 */

import { toBase64 } from "../../../shared/base64";
import { decodeWire, isPlainObject } from "../../../shared/wire-codec";

/**
 * One change record in a {@link ConnectorSyncPage}. Mirrors a row of the CDC log
 * the shard / D1 change feed produces: an `op` (insert / update / delete), the
 * owning `table`, and the document. `op` is normalised to the three warehouse
 * verbs; an unknown / absent op is treated as `"upsert"` (insert-or-update),
 * which is the safe default for change feeds that don't distinguish the two.
 */
interface ConnectorChange {
    /** The full document. For a delete, may carry only the primary key. */
    doc: Record<string, unknown>;
    /** Change verb. `upsert` collapses insert+update for feeds that don't separate them. */
    op: "delete" | "insert" | "update" | "upsert";
    /** Source table this change belongs to. */
    table: string;
}

/**
 * A page of changes the connector endpoint returns. `nextCursor` is an opaque
 * token the consumer stores and re-posts verbatim to resume; never parse it.
 * `hasMore` is `true` while the source has further pages past this one — keep
 * paging until it is `false` (caught up).
 */
interface ConnectorSyncPage {
    changes: ReadonlyArray<ConnectorChange>;
    hasMore: boolean;
    /** Opaque resume token. Treat as a black box; store and re-send unchanged. */
    nextCursor: string;
}

/**
 * Fivetran connector-function response envelope. A Fivetran custom function
 * returns this object: `state` is persisted by Fivetran and handed back on the
 * next sync (map it straight to {@link ConnectorSyncPage.nextCursor}), the
 * `insert` / `update` / `delete` maps bucket records per table, `hasMore` drives
 * Fivetran's "call me again immediately" loop, and `schema` declares each table's
 * primary key.
 *
 * See https://fivetran.com/docs/connectors/functions#responseformat.
 */
interface FivetranResponse {
    delete: Record<string, Record<string, unknown>[]>;
    hasMore: boolean;
    insert: Record<string, Record<string, unknown>[]>;
    schema: Record<string, { primary_key: string[] }>;
    state: { cursor: string };
    update: Record<string, Record<string, unknown>[]>;
}

/** One Airbyte protocol message (a `RECORD` row or a `STATE` checkpoint). */
type AirbyteMessage =
    | {
          record: { data: Record<string, unknown>; emitted_at: number; stream: string };
          type: "RECORD";
      }
    | {
          state: { data: { cursor: string } };
          type: "STATE";
      };

/** Default primary-key column for Lunora documents. */
const DEFAULT_PRIMARY_KEY = "_id";

/**
 * Map a decoded value to warehouse-portable JSON: a `bigint` becomes a number
 * when it fits the safe-integer range (else its decimal string), bytes become
 * a base64 string, containers recurse, pure JSON passes through unchanged.
 */
const toPortableJson = (value: unknown): unknown => {
    if (typeof value === "bigint") {
        return value >= Number.MIN_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value.toString();
    }

    if (value instanceof ArrayBuffer) {
        return toBase64(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) {
        return toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }

    if (Array.isArray(value)) {
        return value.map((item) => toPortableJson(item));
    }

    if (isPlainObject(value)) {
        const result: Record<string, unknown> = {};

        for (const key of Object.keys(value)) {
            const mapped = toPortableJson(value[key]);

            if (key === "__proto__") {
                // A plain assignment for a literal `__proto__` field fires the
                // prototype setter instead of creating an own property (see the
                // same handling in shared/wire-codec) — install it explicitly.
                Object.defineProperty(result, key, { configurable: true, enumerable: true, value: mapped, writable: true });
            } else {
                result[key] = mapped;
            }
        }

        return result;
    }

    return value;
};

/**
 * Decode a wire-form doc (as shard admin RPCs return it) and map every
 * non-JSON leaf to a warehouse-portable value. Identity for pure-JSON docs.
 */
const toPortableDocument = (wireDocument: Record<string, unknown>): Record<string, unknown> =>
    toPortableJson(decodeWire(wireDocument)) as Record<string, unknown>;

/**
 * Format a {@link ConnectorSyncPage} as a Fivetran connector-function response.
 *
 * Inserts and upserts both land in `insert` (Fivetran upserts on primary key, so
 * an insert and an update of an existing row are wire-identical); explicit
 * updates land in `update`; deletes in `delete`. `state.cursor` carries the
 * opaque resume token Fivetran will echo back on the next invocation.
 * @param page the page returned by the connector sync endpoint.
 * @param primaryKey the primary-key column per table (default `"_id"`); pass a
 * map to override per table, used to fill the `schema` block.
 */
const toFivetranResponse = (page: ConnectorSyncPage, primaryKey: Record<string, string> | string = DEFAULT_PRIMARY_KEY): FivetranResponse => {
    // Null-prototype accumulators: `change.table` is connector input, so a
    // proto-string table name (`__proto__`, `constructor`) must not reach
    // Object.prototype's setters — write it as an own property instead.
    const insert = Object.create(null) as Record<string, Record<string, unknown>[]>;
    const update = Object.create(null) as Record<string, Record<string, unknown>[]>;
    const remove = Object.create(null) as Record<string, Record<string, unknown>[]>;
    const schema = Object.create(null) as Record<string, { primary_key: string[] }>;

    const pkFor = (table: string): string => (typeof primaryKey === "string" ? primaryKey : (primaryKey[table] ?? DEFAULT_PRIMARY_KEY));

    const bucketFor = (target: Record<string, Record<string, unknown>[]>, table: string): Record<string, unknown>[] => {
        const existing = target[table];

        if (existing) {
            return existing;
        }

        const created: Record<string, unknown>[] = [];

        // eslint-disable-next-line no-param-reassign -- `target` is one of the local accumulator maps owned by this function; mutating it in place is the intent
        target[table] = created;

        return created;
    };

    for (const change of page.changes) {
        schema[change.table] ??= { primary_key: [pkFor(change.table)] };

        const portable = toPortableDocument(change.doc);

        if (change.op === "delete") {
            bucketFor(remove, change.table).push(portable);
        } else if (change.op === "update") {
            bucketFor(update, change.table).push(portable);
        } else {
            // `insert`, `upsert`, and any op outside the Fivetran verbs (a
            // connector that has drifted from the schema) all land in `insert` —
            // Fivetran upserts on primary key, so the row still lands and a sync
            // never hard-fails on one unknown op.
            bucketFor(insert, change.table).push(portable);
        }
    }

    return { delete: remove, hasMore: page.hasMore, insert, schema, state: { cursor: page.nextCursor }, update };
};

/**
 * Format a {@link ConnectorSyncPage} as an ordered array of Airbyte protocol
 * messages: one `RECORD` per change (stream = table name), followed by a single
 * trailing `STATE` message carrying the opaque cursor. An Airbyte source serializes
 * these as line-delimited JSON to stdout.
 *
 * Airbyte's protocol has no native delete verb in `RECORD`; a delete is emitted
 * as a `RECORD` with a `_lunora_deleted: true` marker on the row so a downstream
 * normalization / dbt step can tombstone it. Callers needing true CDC deletes
 * should run Airbyte's CDC-deletion handling on that marker.
 * @param page the page returned by the connector sync endpoint.
 * @param emittedAt epoch-ms stamped on each `RECORD` (default `Date.now()`).
 */
const toAirbyteMessages = (page: ConnectorSyncPage, emittedAt: number = Date.now()): AirbyteMessage[] => {
    const messages: AirbyteMessage[] = [];

    for (const change of page.changes) {
        const portable = toPortableDocument(change.doc);
        const data = change.op === "delete" ? { ...portable, _lunora_deleted: true } : portable;

        messages.push({ record: { data, emitted_at: emittedAt, stream: change.table }, type: "RECORD" });
    }

    messages.push({ state: { data: { cursor: page.nextCursor } }, type: "STATE" });

    return messages;
};

export type { AirbyteMessage, ConnectorChange, ConnectorSyncPage, FivetranResponse };
export { toAirbyteMessages, toFivetranResponse };
