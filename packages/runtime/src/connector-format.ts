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
 */

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
    const insert: Record<string, Record<string, unknown>[]> = {};
    const update: Record<string, Record<string, unknown>[]> = {};
    const remove: Record<string, Record<string, unknown>[]> = {};
    const schema: Record<string, { primary_key: string[] }> = {};

    const pkFor = (table: string): string => (typeof primaryKey === "string" ? primaryKey : (primaryKey[table] ?? DEFAULT_PRIMARY_KEY));

    // `insert` and `upsert` both map to Fivetran's upsert-on-PK `insert`.
    const buckets = { delete: remove, insert, update, upsert: insert };

    for (const change of page.changes) {
        schema[change.table] ??= { primary_key: [pkFor(change.table)] };

        const bucket = buckets[change.op][change.table] ?? [];

        buckets[change.op][change.table] = bucket;
        bucket.push(change.doc);
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
        const data = change.op === "delete" ? { ...change.doc, _lunora_deleted: true } : change.doc;

        messages.push({ record: { data, emitted_at: emittedAt, stream: change.table }, type: "RECORD" });
    }

    messages.push({ state: { data: { cursor: page.nextCursor } }, type: "STATE" });

    return messages;
};

export type { AirbyteMessage, ConnectorChange, ConnectorSyncPage, FivetranResponse };
export { toAirbyteMessages, toFivetranResponse };
