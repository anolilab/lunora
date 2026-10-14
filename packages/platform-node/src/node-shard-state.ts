/**
 * Present a {@link NodeShard} in the shape `ShardDO` expects of a
 * `DurableObjectState`, so the real shard class can run on this host.
 *
 * # Why this exists, and why it is the wrong shape long-term
 *
 * `@lunora/do`'s `ShardDO` is the shard request handler — the thing a resolved
 * stub's `fetch` has to reach for an app to actually serve a query. Its
 * constructor takes a `state` and builds the Cloudflare adapters from it
 * itself (`createShardHost(state)`, `createSocketHost(state)`), so it cannot be
 * handed the `@lunora/platform` contracts a host already implements. The
 * platform seam stops one layer below where it needs to be.
 *
 * That leaves two options: fork `ShardDO`, or adapt in the other direction —
 * project this host's contracts back into the `DurableObjectState` shape
 * `ShardDO` will re-adapt into contracts. This module is the second, and it is
 * deliberately the smaller mistake: it is ~100 lines that disappear the day
 * `ShardDO` accepts a `ShardPlatform`, whereas a fork is 8,700 lines that
 * diverge forever.
 *
 * It is honest about being a bridge rather than a destination. Recorded as a
 * finding in `plans/234-node-host-findings.md`; the fix belongs in
 * `@lunora/do`, not here.
 *
 * # What makes it viable
 *
 * `ShardDOState` is fully structural, and almost every member is optional —
 * only `acceptWebSocket`, `getWebSockets` and `storage.sql` are required,
 * because the class is already driven by plain-object doubles in its own unit
 * suite. Every member below is backed by a real implementation rather than a
 * stub: SQL and transactions by `better-sqlite3`, alarms by the durable
 * `_lunora_alarm` row, the key-value surface by `_lunora_kv`, and sockets by
 * the persisted registry. Nothing here is a no-op that would let a request
 * appear to succeed while doing nothing.
 */

import type { NodeShard } from "./node-shard-registry";

/**
 * The `DurableObjectState` subset `ShardDO` consumes.
 *
 * Declared here rather than imported so this package keeps no dependency on
 * `@lunora/do` (which depends on `@lunora/platform-cloudflare`, and through it
 * on Cloudflare's types). Structural typing does the rest: a value of this type
 * satisfies `ShardDO`'s constructor parameter without the two ever meeting at
 * the type level.
 */
export interface NodeShardState {
    acceptWebSocket: (socket: unknown, tags?: string[]) => void;
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => Promise<T>;
    getWebSockets: (tag?: string) => unknown[];
    id: { name?: string };
    storage: {
        delete: (key: string) => Promise<boolean>;
        deleteAlarm: () => Promise<void>;
        get: <T = unknown>(key: string) => Promise<T | undefined>;
        getAlarm: () => Promise<number | null>;
        list: <T = unknown>(options?: { prefix?: string }) => Promise<Map<string, T>>;
        put: (key: string, value: unknown) => Promise<void>;
        setAlarm: (scheduledTime: Date | number) => Promise<void>;
        sql: {
            readonly databaseSize?: number;
            exec: (query: string, ...bindings: unknown[]) => unknown;
        };
        transaction: <T>(closure: () => Promise<T>) => Promise<T>;
    };
    waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Project a shard's platform contracts into the `DurableObjectState` shape.
 *
 * Deliberately **not** exposing the native-PITR members
 * (`getBookmarkForTime` / `getCurrentBookmark` /
 * `onNextSessionRestoreBookmark`) or `setWebSocketAutoResponse`: those are
 * Cloudflare runtime features with no Node equivalent, and `ShardDO` probes for
 * each before use. Omitting them takes the documented degraded path — the same
 * one local `wrangler dev` takes — whereas supplying a stub that resolves would
 * report a point-in-time restore that never happened.
 */
export const createNodeShardState = (shard: NodeShard): NodeShardState => {
    return {
        // The socket host adopts the transport AS its handle and stamps
        // `serializeAttachment`/`deserializeAttachment`/`close` onto it, so
        // there is nothing to bridge here and — the part that matters —
        // `getWebSockets` below hands back the very objects the adapter
        // accepted. Cloudflare's `createSocketHost` returns the runtime socket
        // from `accept`/`handleFor` and enumerates the same objects from
        // `getSockets`; a host that enumerated a second, wrapper object made
        // every fan-out frame (pokes, deltas, relay broadcast) write into an
        // in-process array instead of the wire, and made per-socket memos and
        // `ws !== closing` comparisons miss.
        acceptWebSocket: (socket, tags) => {
            shard.sockets.accept(socket, undefined, tags);
        },
        blockConcurrencyWhile: (callback) => shard.shard.runSerialized(callback),
        getWebSockets: (tag) => shard.sockets.getSockets(tag),
        // `ShardDO` reads `id.name` to detect the root shard (`__root__`), so
        // this has to carry the real key rather than an opaque id.
        id: { name: shard.shardKey },
        storage: {
            delete: (key) => shard.kv.delete(key),
            deleteAlarm: async () => {
                await shard.shard.alarms.delete();
            },
            get: (key) => shard.kv.get(key),
            getAlarm: async () => shard.shard.alarms.get(),
            list: (options) => shard.kv.list(options),
            put: (key, value) => shard.kv.put(key, value),
            setAlarm: async (scheduledTime) => {
                await shard.shard.alarms.set(scheduledTime);
            },
            sql: {
                // A live getter, matching the contract's "recomputed on each
                // read, do not cache" note — a cached size reports the shard's
                // birth weight for its whole life.
                get databaseSize(): number | undefined {
                    return shard.shard.sql.databaseSize;
                },
                exec: (query, ...bindings) => shard.shard.sql.exec(query, ...bindings),
            },
            transaction: (closure) => shard.shard.transaction(closure),
        },
        waitUntil: (promise) => {
            shard.shard.waitUntil?.(promise);
        },
    };
};
