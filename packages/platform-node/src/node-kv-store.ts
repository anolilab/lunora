/**
 * Node adapter: a `better-sqlite3`-backed table satisfying the provider-neutral
 * `@lunora/platform` `ShardKvStore` contract.
 *
 * `ShardKvStore.put`'s docstring says "the value must be structured-clonable;
 * hosts serialize it durably" — it does not pin a wire format. Cloudflare's
 * `state.storage` serializes with the platform's own structured-clone
 * implementation, which round-trips `Date`, `Map`, `Set`, `RegExp`, typed
 * arrays, and more. The reference host (an in-memory `Map`) gets the same
 * fidelity for free by calling Node's built-in `structuredClone` on write. A
 * real SQLite-backed store has no such shortcut: the value has to survive as
 * raw bytes. Two candidates were available:
 *
 * - `JSON.stringify` — round-trips plain objects/arrays/strings/numbers/
 * booleans/null, and silently mangles or drops everything else (`Date`
 * becomes a string with no way back, `Map`/`Set`/`undefined` vanish,
 * `Infinity`/`NaN` become `null`).
 * - `node:v8`'s `serialize`/`deserialize` — uses the same structured-clone
 * algorithm V8 uses for `postMessage` and (on Node) `structuredClone`
 * itself, so it round-trips `Date`, `Map`, `Set`, `RegExp`, and typed arrays
 * as a `Buffer` that a SQLite `BLOB` column stores natively.
 *
 * This host uses `node:v8` — genuinely closer to Cloudflare's fidelity than
 * `JSON.stringify` would be — but it is still a DIFFERENT serializer than
 * either Cloudflare or the reference host use, and `v8.serialize` is
 * explicitly documented by Node as **not** a stable, cross-version wire
 * format: a value written by one Node/V8 version is not guaranteed to
 * `deserialize` on another. That is a real persistence-semantics divergence
 * the contract does not pin down anywhere — see the findings log.
 */

import { deserialize, serialize } from "node:v8";

import type { ShardKvListOptions, ShardKvStore } from "@lunora/platform";
import type Database from "better-sqlite3";

/** Build a `ShardKvStore` over a `better-sqlite3` table in the shard's database. */
export const createNodeShardKvStore = (database: Database.Database): ShardKvStore => {
    database.exec("CREATE TABLE IF NOT EXISTS _lunora_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL)");

    const getStatement = database.prepare<[string], { value: Buffer }>("SELECT value FROM _lunora_kv WHERE key = ?");
    const putStatement = database.prepare<[string, Buffer]>(
        "INSERT INTO _lunora_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    const deleteStatement = database.prepare<[string]>("DELETE FROM _lunora_kv WHERE key = ?");
    const scanStatement = database.prepare<[], { key: string; value: Buffer }>("SELECT key, value FROM _lunora_kv");

    return {
        // eslint-disable-next-line @typescript-eslint/require-await -- the contract's delete is async so a real host can await I/O; this one is synchronous SQLite
        delete: async (key) => {
            const result = deleteStatement.run(key);

            return result.changes > 0;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `delete`
        get: async <T = unknown>(key: string): Promise<T | undefined> => {
            const row = getStatement.get(key);

            return row === undefined ? undefined : (deserialize(row.value) as T);
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `delete`
        list: async <T = unknown>(options?: ShardKvListOptions): Promise<Map<string, T>> => {
            const prefix = options?.prefix ?? "";
            // A LIKE-with-escaped-wildcards prefix scan would be the production
            // move; for a spike, filter in JS the way the reference host's `Map`
            // scan does — it keeps the query trivially correct while `%`/`_` in a
            // real key would need escaping either way.
            const rows = scanStatement.all();
            const result = new Map<string, T>();

            for (const row of rows) {
                if (row.key.startsWith(prefix)) {
                    result.set(row.key, deserialize(row.value) as T);
                }
            }

            return result;
        },
        // eslint-disable-next-line @typescript-eslint/require-await -- see `delete`
        put: async (key, value) => {
            putStatement.run(key, serialize(value));
        },
    };
};
