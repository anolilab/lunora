import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/client";
import type { ServerClientOptions } from "@lunora/client/ssr";
import { createServerClient } from "@lunora/client/ssr";
import type { QueryClient } from "@tanstack/react-query";

import { lunoraQueryKey } from "./query-key";

/**
 * Server-side data-loading helpers for React Server Components.
 *
 * This module is the server half of `@lunora/react`: it carries no
 * `"use client"` directive, opens no WebSocket, and touches no browser globals,
 * so it is safe to import from an RSC / Next.js Server Component. The browser
 * hooks (`useQuery`, `usePreloadedQuery`, …) live in the package root,
 * `@lunora/react`, which is a client boundary.
 *
 * Two flows are supported, mirroring the two common RSC patterns. First,
 * hydrating the TanStack cache: `prefetchQuery` runs the query on the server and
 * seeds a `QueryClient` under the exact key the client `useQuery` reads back, so
 * the client renders with data on the first paint and a live WS subscription
 * attaches on mount. Second, the explicit-token flow: `preloadQuery` returns a
 * serializable `Preloaded` value you hand to a client component that calls
 * `usePreloadedQuery`.
 */

// The TanStack options factory is transport-free, so it works server-side too:
// `await queryClient.ensureQueryData(lunoraQueryOptions(serverClient, fn, args))`.
export type { LunoraQueryOptions } from "./query-options";
export { lunoraQueryOptions } from "./query-options";

/**
 * Run a query on the server and seed `queryClient` with the result under the
 * same key the client hooks use (see `lunoraQueryKey`), so a later
 * `useQuery(fn, args)` reads it straight from the hydrated cache — no loading
 * flash, no duplicate fetch on the client.
 *
 * Pair it with TanStack's `dehydrate` + `HydrationBoundary` (both re-exported
 * from this module): prefetch into a fresh `QueryClient`, `dehydrate` it, wrap
 * the client subtree in `HydrationBoundary`, and the client hooks pick the value
 * up from cache. Errors propagate — wrap the call if you'd rather render a
 * fallback than fail the server render. Drop the `await` for fire-and-forget
 * prefetch when you don't need the data present on the very first paint.
 */
export const prefetchQuery = async <F extends FunctionReference>(
    queryClient: QueryClient,
    client: LunoraClient,
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): Promise<void> => {
    const argsRecord = (args ?? {}) as Record<string, unknown>;

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- not a React hook: prefetchQuery runs once server-side and the queryKey intentionally excludes the non-serializable, request-stable client.
    await queryClient.prefetchQuery({
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey: options.shardKey }),
        queryKey: lunoraQueryKey(function_, argsRecord, options.shardKey),
        // Match the client hooks: Lunora is push-driven, so the seeded value is
        // never considered stale by TanStack — the WS subscription that attaches
        // on mount is the only freshness signal.
        staleTime: Number.POSITIVE_INFINITY,
    });
};

/** Per-call options shared by the one-shot `fetch*` helpers. */
export interface ServerCallOptions {
    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * Run a query once on the server and return its result — the standalone
 * counterpart to `prefetchQuery`/`preloadQuery` for when you just want the data
 * inline in a Server Component (e.g. to compute metadata or branch on a value)
 * rather than seed a cache or hand a `Preloaded` to the client.
 *
 * Builds a fresh request-scoped client per call (see `createServerClient`), so
 * pass `token` to run as the signed-in user. For several reads in one request,
 * prefer holding one `createServerClient` and calling `.query()` yourself to
 * avoid rebuilding the transport each time. Errors propagate.
 */
export const fetchQuery = async <F extends FunctionReference>(
    options: ServerClientOptions,
    function_: F,
    args: ArgsOf<F>,
    callOptions: ServerCallOptions = {},
): Promise<ReturnOf<F>> => createServerClient(options).query<F>(function_, args, { shardKey: callOptions.shardKey });

/**
 * Run a mutation once on the server and return its result. Server-side calls go
 * straight over HTTP RPC — the offline queue and optimistic-update machinery are
 * client-only and never engage here. Errors propagate.
 */
export const fetchMutation = async <F extends FunctionReference>(
    options: ServerClientOptions,
    function_: F,
    args: ArgsOf<F>,
    callOptions: ServerCallOptions = {},
): Promise<ReturnOf<F>> => createServerClient(options).mutation<F>(function_, args, { shardKey: callOptions.shardKey });

/**
 * Run an action once on the server and return its result. Errors propagate.
 */
export const fetchAction = async <F extends FunctionReference>(
    options: ServerClientOptions,
    function_: F,
    args: ArgsOf<F>,
    callOptions: ServerCallOptions = {},
): Promise<ReturnOf<F>> => createServerClient(options).action<F>(function_, args, { shardKey: callOptions.shardKey });

export type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "@lunora/client";
// Re-exported so callers can do all server-side data loading from one import.
// `preloadQuery`/`preloadedQueryResult` are the explicit-token flow; `dehydrate`
// is a pure serializer (server-safe); `HydrationBoundary` carries its own client
// boundary from TanStack, so re-exporting it here is just a convenience pass-through.
export { preloadedQueryResult, preloadQuery } from "@lunora/client";
// `createServerClient`/`ServerClientOptions` are sourced from `@lunora/client/ssr`, the
// framework-neutral home of the server contract, so there is one implementation
// shared across every adapter. They are re-exported (not re-implemented) here so
// existing `import { createServerClient } from "@lunora/react/server"` keeps
// working unchanged — same name, same signature. `getServerSession`, the
// `serializePreloaded`/`deserializePreloaded` dehydrate helpers, and
// `preloadQuery` are re-exported too so a React SSR loader can get everything it
// needs from this one entry.
export type { AuthLike, HeadersSource, ServerClientOptions, ServerSession } from "@lunora/client/ssr";
export { createServerClient, deserializePreloaded, getServerSession, serializePreloaded } from "@lunora/client/ssr";
export { dehydrate, HydrationBoundary } from "@tanstack/react-query";
