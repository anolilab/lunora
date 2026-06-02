import type { ArgsOf, FunctionReference } from "@cirrus/client";
import { CirrusClient } from "@cirrus/client";
import type { QueryClient } from "@tanstack/react-query";

import { cirrusQueryKey } from "./query-key.js";

/**
 * Server-side data-loading helpers for React Server Components.
 *
 * This module is the server half of `@cirrus/react`: it carries no
 * `"use client"` directive, opens no WebSocket, and touches no browser globals,
 * so it is safe to import from an RSC / Next.js Server Component. The browser
 * hooks (`useQuery`, `usePreloadedQuery`, …) live in the package root,
 * `@cirrus/react`, which is a client boundary.
 *
 * Two flows are supported, mirroring the two common RSC patterns. First,
 * hydrating the TanStack cache: `prefetchQuery` runs the query on the server and
 * seeds a `QueryClient` under the exact key the client `useQuery` reads back, so
 * the client renders with data on the first paint and a live WS subscription
 * attaches on mount. Second, the explicit-token flow: `preloadQuery` returns a
 * serializable `Preloaded` value you hand to a client component that calls
 * `usePreloadedQuery`.
 */

/** Options accepted by `createServerClient`. */
export interface ServerClientOptions {
    /**
     * `fetch` implementation used for HTTP RPC. Defaults to the ambient global
     * `fetch` (present in Node 18+, Workers, and the Next.js server runtime).
     * Pass one explicitly to forward cookies/headers or to use an instrumented
     * fetch.
     */
    fetch?: typeof fetch;

    /**
     * Bearer token sent as `Authorization: Bearer &lt;token>` on every RPC. In an
     * RSC you typically read this from the request (e.g. a cookie via
     * `next/headers`) and pass it here so the server-side load runs as the
     * signed-in user.
     */
    token?: string;

    /** Base URL of the deployed Cirrus worker, e.g. `https://app.example.workers.dev`. */
    url: string;
}

/**
 * Build a request-scoped `CirrusClient` for use inside a Server Component. RSC
 * data loading only ever calls `.query()` (HTTP RPC over `fetch`); a
 * `CirrusClient` opens a socket lazily on `.subscribe()`/`.stream()` and those
 * are never called server-side, so no live connection is established even if the
 * server runtime happens to expose a global `WebSocket`.
 *
 * Create one per request rather than sharing a module-level instance: the bearer
 * token (and any forwarded cookies in `fetch`) are per-user, and a shared client
 * would leak one request's identity into another.
 */
export const createServerClient = (options: ServerClientOptions): CirrusClient => {
    // `fetch` falls back to the ambient global inside CirrusClient when omitted.
    const client = new CirrusClient({ fetch: options.fetch, url: options.url });

    if (options.token !== undefined) {
        client.setAuthToken(options.token);
    }

    return client;
};

/**
 * Run a query on the server and seed `queryClient` with the result under the
 * same key the client hooks use (see `cirrusQueryKey`), so a later
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
    client: CirrusClient,
    function_: F,
    args: ArgsOf<F>,
    options: { shardKey?: string } = {},
): Promise<void> => {
    const argsRecord = (args ?? {}) as Record<string, unknown>;

    // eslint-disable-next-line @tanstack/query/exhaustive-deps -- not a React hook: prefetchQuery runs once server-side and the queryKey intentionally excludes the non-serializable, request-stable client.
    await queryClient.prefetchQuery({
        queryFn: () => client.query<F>(function_, argsRecord as ArgsOf<F>, { shardKey: options.shardKey }),
        queryKey: cirrusQueryKey(function_, argsRecord, options.shardKey),
        // Match the client hooks: Cirrus is push-driven, so the seeded value is
        // never considered stale by TanStack — the WS subscription that attaches
        // on mount is the only freshness signal.
        staleTime: Number.POSITIVE_INFINITY,
    });
};

export type { ArgsOf, FunctionReference, Preloaded, ReturnOf } from "@cirrus/client";
// Re-exported so callers can do all server-side data loading from one import.
// `preloadQuery`/`preloadedQueryResult` are the explicit-token flow; `dehydrate`
// is a pure serializer (server-safe); `HydrationBoundary` carries its own client
// boundary from TanStack, so re-exporting it here is just a convenience pass-through.
export { preloadedQueryResult, preloadQuery } from "@cirrus/client";
export { dehydrate, HydrationBoundary } from "@tanstack/react-query";
