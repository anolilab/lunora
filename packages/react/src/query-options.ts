import type { ArgsOf, LunoraClient, FunctionReference, ReturnOf } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";

import { lunoraQueryKey } from "./query-key";

/**
 * Pure, transport-free adapter between a Lunora function reference and a
 * TanStack Query options object. No `"use client"` directive and only a
 * type-level `@lunora/client` import, so it is safe to use on either side of an
 * RSC boundary (the runtime transport is the `LunoraClient` you pass in).
 *
 * Use it when you want to drive a Lunora query through TanStack's own hooks —
 * `useSuspenseQuery`, `useQueries`, or the server-side
 * `queryClient.ensureQueryData` / `prefetchQuery` — rather than the first-class
 * `useQuery` from `@lunora/react`.
 */

/** Shape returned by `lunoraQueryOptions`, spread into a TanStack hook. */
export interface LunoraQueryOptions<F extends FunctionReference> {
    queryFn: () => Promise<ReturnOf<F>>;
    queryKey: QueryKey;
    staleTime: number;
}

/**
 * Build a TanStack Query options object for a Lunora query, keyed identically
 * to the first-class hooks (see `lunoraQueryKey`) so a value fetched through
 * this adapter shares cache identity with anything `useQuery` /
 * `prefetchQuery` reads or writes for the same `(fn, args, shardKey)` triple.
 *
 * ```ts
 * const { data } = useSuspenseQuery(lunoraQueryOptions(client, api.posts.list, {}));
 * ```
 *
 * This is a one-shot fetch: it resolves once and `staleTime` is infinite, so
 * TanStack never refetches on its own. It does not open a WebSocket — for live
 * updates that re-render on every server push, use `useQuery` from
 * `@lunora/react`, which attaches a shared subscription to the same cache key.
 */
export const lunoraQueryOptions = <F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): LunoraQueryOptions<F> => {
    const argsRecord = (args ?? {}) as Record<string, unknown>;

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- not a React hook: this is a plain options factory and the queryKey intentionally excludes the non-serializable, caller-stable client (a client object in the key would break cache identity).
    return {
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey: options.shardKey }),
        queryKey: lunoraQueryKey(function_, argsRecord, options.shardKey),
        // Lunora is push-driven: the value never goes stale on a timer. For
        // reactivity use `useQuery`; this adapter is a one-shot/suspense read.
        staleTime: Number.POSITIVE_INFINITY,
    };
};
