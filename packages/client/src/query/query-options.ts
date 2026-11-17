import { stableWireKey } from "@lunora/wire";

import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "../index";

/**
 * The TanStack Query cache-key contract for Lunora queries. It lives here, not
 * in an adapter, because every TanStack binding (React, Vue, Solid, Svelte,
 * Angular Query) hashes keys the same way, and a value prefetched through one
 * entry point must land under the exact key a hook reads back.
 *
 * Typed as `ReadonlyArray<unknown>` — TanStack v5's default `QueryKey` — so this
 * module needs no TanStack dependency.
 */
type LunoraQueryKey = ReadonlyArray<unknown>;

/**
 * Project a Lunora `(fn, args, shardKey)` triple into the query key TanStack
 * hashes for dedup. The `"lunora"` literal namespaces our entries so an app's
 * own queries can't collide with ours.
 *
 * `args` sits in the key already encoded by `stableWireKey`, not as the raw
 * object. TanStack hashes keys with `JSON.stringify`, which maps `NaN` to
 * `null`, `-0` to `0` and a `Date` to its ISO string (so distinct args shared
 * one cache entry and served each other's rows) and throws on a `bigint`. A
 * string slot hashes the same under any hash function, so every QueryClient
 * agrees on it without configuration.
 */
const lunoraQueryKeyFromArgsKey = (ref: string, argsKey: string, shardKey: string | undefined): LunoraQueryKey => [
    "lunora",
    ref,
    argsKey,
    // eslint-disable-next-line unicorn/no-null -- this literal is part of the JSON-serialized query key TanStack hashes for dedup; `null` keeps a stable, distinct slot from an absent shardKey.
    shardKey ?? null,
];

const lunoraQueryKey = (function_: FunctionReference, args: Record<string, unknown>, shardKey: string | undefined): LunoraQueryKey =>
    lunoraQueryKeyFromArgsKey(function_.__lunoraRef, stableWireKey(args), shardKey);

/** Shape returned by `lunoraQueryOptions`, spread into a TanStack hook. */
interface LunoraQueryOptions<F extends FunctionReference> {
    queryFn: () => Promise<ReturnOf<F>>;
    queryKey: LunoraQueryKey;
    staleTime: number;
}

/**
 * Build a TanStack Query options object for a Lunora query, keyed identically
 * to the adapters' first-class hooks (see `lunoraQueryKey`), so a value fetched
 * through it shares cache identity with anything those hooks or a server-side
 * `prefetchQuery` read or write for the same `(fn, args, shardKey)` triple.
 *
 * ```ts
 * const { data } = useSuspenseQuery(lunoraQueryOptions(client, api.posts.list, {}));
 * ```
 *
 * This is a one-shot fetch: it resolves once and `staleTime` is infinite, so
 * TanStack never refetches on its own. It opens no WebSocket and has no
 * framework or browser dependency, so it is safe on either side of an RSC
 * boundary — the transport is the `LunoraClient` passed in.
 */
const lunoraQueryOptions = <F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): LunoraQueryOptions<F> => {
    const argsRecord = (args ?? {}) as Record<string, unknown>;

    // The client stays out of the key: it is not serializable, and an object in the key would break cache identity.
    return {
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey: options.shardKey }),
        queryKey: lunoraQueryKey(function_, argsRecord, options.shardKey),
        // Lunora is push-driven: the value never goes stale on a timer. Reactivity
        // comes from the adapters' live hooks attaching to the same key.
        staleTime: Number.POSITIVE_INFINITY,
    };
};

export type { LunoraQueryKey, LunoraQueryOptions };
export { lunoraQueryKey, lunoraQueryKeyFromArgsKey, lunoraQueryOptions };
