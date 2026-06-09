import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf } from "@cirrus/client";
import type { QueryKey } from "@tanstack/react-query";

import { cirrusQueryKey } from "./query-key";

/**
 * Pure, transport-free adapter between a Cirrus function reference and a
 * TanStack Query options object. No `"use client"` directive and only a
 * type-level `@cirrus/client` import, so it is safe to use on either side of an
 * RSC boundary (the runtime transport is the `CirrusClient` you pass in).
 *
 * Use it when you want to drive a Cirrus query through TanStack's own hooks —
 * `useSuspenseQuery`, `useQueries`, or the server-side
 * `queryClient.ensureQueryData` / `prefetchQuery` — rather than the first-class
 * `useQuery` from `@cirrus/react`.
 */

/** Shape returned by `cirrusQueryOptions`, spread into a TanStack hook. */
export interface CirrusQueryOptions<F extends FunctionReference> {
    queryFn: () => Promise<ReturnOf<F>>;
    queryKey: QueryKey;
    staleTime: number;
}

/**
 * Build a TanStack Query options object for a Cirrus query, keyed identically
 * to the first-class hooks (see `cirrusQueryKey`) so a value fetched through
 * this adapter shares cache identity with anything `useQuery` /
 * `prefetchQuery` reads or writes for the same `(fn, args, shardKey)` triple.
 *
 * ```ts
 * const { data } = useSuspenseQuery(cirrusQueryOptions(client, api.posts.list, {}));
 * ```
 *
 * This is a one-shot fetch: it resolves once and `staleTime` is infinite, so
 * TanStack never refetches on its own. It does not open a WebSocket — for live
 * updates that re-render on every server push, use `useQuery` from
 * `@cirrus/react`, which attaches a shared subscription to the same cache key.
 */
export const cirrusQueryOptions = <F extends FunctionReference>(
    client: CirrusClient,
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): CirrusQueryOptions<F> => {
    const argsRecord = (args ?? {}) as Record<string, unknown>;

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- not a React hook: this is a plain options factory and the queryKey intentionally excludes the non-serializable, caller-stable client (a client object in the key would break cache identity).
    return {
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey: options.shardKey }),
        queryKey: cirrusQueryKey(function_, argsRecord, options.shardKey),
        // Cirrus is push-driven: the value never goes stale on a timer. For
        // reactivity use `useQuery`; this adapter is a one-shot/suspense read.
        staleTime: Number.POSITIVE_INFINITY,
    };
};
