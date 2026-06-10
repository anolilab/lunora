/**
 * `@cirrus/vue` — the Vue adapter for Cirrus.
 *
 * Thin, idiomatic glue over the framework-neutral `@cirrus/client` (which owns
 * the WebSocket transport, subscription registry, offline queue, and
 * delta-merge — zero React, zero Vue). This package re-expresses that contract
 * as Vue composables:
 *
 * - `createCirrus` / `provideCirrus` / `useCirrusClient` — provide/inject the client.
 * - `useQuery` — a live `ref` that opens a WS subscription and updates on deltas.
 * - `useMutation` — an optimistic mutation handle (refs + awaitable `mutate`).
 * - `hydratePreloaded` — seed a `ref` synchronously from an SSR `Preloaded` token (no loading flash), then attach the live subscription.
 *
 * Server-side preload helpers live in the socket-free `@cirrus/vue/server`
 * entry (`createServerClient`, `preloadQuery`).
 */
export { CIRRUS_INJECTION_KEY, createCirrus, provideCirrus, useCirrusClient } from "./cirrus-provider";
export { hydratePreloaded } from "./hydrate-preloaded";
export type {
    ArgsOf,
    CirrusClient,
    FunctionReference,
    OptimisticLocalStore,
    OptimisticUpdate,
    Preloaded,
    ReturnOf,
    Unsubscribe,
    UseMutationCallOptions,
    UseQueryOptions,
    User,
} from "./types";
export type { MutationHandle } from "./use-mutation";
export { useMutation } from "./use-mutation";
export { subscribeToQuery, useQuery } from "./use-query";
