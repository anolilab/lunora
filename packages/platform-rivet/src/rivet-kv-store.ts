/**
 * Rivet adapter: the provider-neutral `@lunora/platform` `ShardKvStore` over a
 * table in the actor's own SQLite database.
 *
 * ## Why not `c.kv`
 *
 * Rivet ships a key-value store on the actor context whose shape is almost a
 * literal match for this contract — `get`/`put`/`delete`, prefix and range
 * scans, actor-scoped and durable. It is also, in Rivet's own words, "a
 * low-level escape hatch kept for backward compatibility", carrying an
 * `@deprecated` tag on every member. Building the durable record store for a
 * new host on a primitive its vendor has already deprecated buys a shorter
 * adapter and a migration nobody scheduled. The table below is a dozen lines
 * more code and sits on the storage Rivet actually recommends.
 *
 * The Rivet `keyValueStore` capability reads `emulated` for exactly this
 * reason: `native` would describe the `c.kv` version of this file, not this
 * one.
 *
 * ## Why this one talks to Rivet directly, when the shard's SQL does not
 *
 * The rest of this package routes storage through the synchronous working copy
 * in `./rivet-shard-state`, because `ShardSqlExec` and `SocketHandle` are
 * synchronous contracts. `ShardKvStore` is not: every member returns a promise,
 * which is the same shape `c.db.execute` already has. Sending it through the
 * working copy would mean re-serializing the entire shard database on every
 * `put` — a snapshot cost with nothing to buy, for the one contract that
 * doesn't need the facade. So this half writes straight through to Rivet, and
 * is durable per write rather than per flush.
 *
 * ## Value encoding
 *
 * `put` accepts anything structured-clonable, so values are encoded with
 * `node:v8` (the same structured-clone algorithm `structuredClone` itself uses
 * on Node) rather than `JSON.stringify`, which would silently drop `undefined`,
 * flatten `Date` to a string with no way back, and lose `Map`/`Set` entirely.
 * The bytes are then base64'd into a TEXT column for the same reason the shard
 * snapshot is — see `./rivet-shard-state`. Two caveats, both inherited from
 * `@lunora/platform-node`, which made the same trade: `v8.serialize` is
 * explicitly not a stable cross-version wire format, and it ties this host to a
 * Node-compatible runtime (which `better-sqlite3` already does).
 */

import { deserialize, serialize } from "node:v8";

import type { ShardKvListOptions, ShardKvStore } from "@lunora/platform";

import type { RivetRawDatabaseLike } from "./rivet-context";

const KV_TABLE = "_lunora_kv";

/** Row shape of the KV table. */
interface KvRow extends Record<string, unknown> {
    key: string;
    value: string;
}

/**
 * Escape a `LIKE` prefix so `%` and `_` in a caller's key are matched as
 * literals.
 *
 * `ShardKvStore.list` promises the result contains *exactly* the keys under the
 * prefix. Without escaping, a prefix of `s_` would also match `sx`, and a
 * prefix sweep — TTL GC, a migration — would delete keys it was never pointed
 * at. Cross-tenant, that is a data-loss bug rather than an off-by-one.
 */
const escapeLikePrefix = (prefix: string): string => prefix.replaceAll(/[\\%_]/gu, (character) => `\\${character}`);

/** Build a `ShardKvStore` over the actor's SQLite database. */
export const createRivetShardKvStore = (database: RivetRawDatabaseLike): { kv: ShardKvStore; ready: Promise<void> } => {
    // Kicked off eagerly and exposed, rather than awaited per call: every
    // member below chains on it, so the table exists before the first read
    // without paying a round trip on each one. The composition root awaits
    // `ready` so a construction failure surfaces there rather than on whichever
    // call happens to be first.
    const ready = database.execute(`CREATE TABLE IF NOT EXISTS ${KV_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`).then(() => undefined);

    const kv: ShardKvStore = {
        delete: async (key) => {
            await ready;

            // Rivet's `execute` resolves to rows, not to a change count, so
            // "was there something to delete" is answered by looking first.
            // `ShardKvStore.delete` documents that distinction as meaningful —
            // a caller uses it to tell a real removal from a no-op — so it
            // cannot be faked with an unconditional `true`.
            const existing = await database.execute<KvRow>(`SELECT key FROM ${KV_TABLE} WHERE key = ?`, key);

            if (existing.length === 0) {
                return false;
            }

            await database.execute(`DELETE FROM ${KV_TABLE} WHERE key = ?`, key);

            return true;
        },
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
            await ready;

            const rows = await database.execute<KvRow>(`SELECT value FROM ${KV_TABLE} WHERE key = ?`, key);
            const row = rows[0];

            return row === undefined ? undefined : (deserialize(Buffer.from(row.value, "base64")) as T);
        },
        list: async <T = unknown>(options?: ShardKvListOptions): Promise<Map<string, T>> => {
            await ready;

            const prefix = options?.prefix ?? "";
            const rows =
                prefix === ""
                    ? await database.execute<KvRow>(`SELECT key, value FROM ${KV_TABLE} ORDER BY key`)
                    : await database.execute<KvRow>(
                          String.raw`SELECT key, value FROM ${KV_TABLE} WHERE key LIKE ? ESCAPE '\' ORDER BY key`,
                          `${escapeLikePrefix(prefix)}%`,
                      );

            return new Map(rows.map((row) => [row.key, deserialize(Buffer.from(row.value, "base64")) as T]));
        },
        put: async (key, value) => {
            await ready;

            await database.execute(
                `INSERT INTO ${KV_TABLE} (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
                key,
                serialize(value).toString("base64"),
            );
        },
    };

    return { kv, ready };
};
