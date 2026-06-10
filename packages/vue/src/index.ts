/**
 * `@cirrus/vue` — the Vue adapter for Cirrus.
 *
 * Thin, idiomatic glue over the framework-neutral `@cirrus/client` (which owns
 * the WebSocket transport, subscription registry, offline queue, and
 * delta-merge — zero React, zero Vue). This package re-expresses that contract
 * as Vue composables:
 *
 * - `createCirrus` / `provideCirrus` / `useCirrus` — provide/inject the client.
 * - `useQuery` — a live `ref` that opens a WS subscription and updates on deltas (reactive args re-subscribe).
 * - `useMutation` — an optimistic mutation handle (refs + awaitable `mutate`).
 * - `hydratePreloaded` — seed a `ref` synchronously from an SSR `Preloaded` token (no loading flash), then attach the live subscription.
 *
 * Server-side preload helpers live in the socket-free `@cirrus/vue/server`
 * entry (`createServerClient`, `preloadQuery`). Single-worker composition for
 * Nuxt (Class-B: inject Cirrus realtime into Nitro's emitted Worker) lives in
 * the Vue-free `@cirrus/vue/worker` entry (`withCirrus`).
 */
export { CIRRUS_INJECTION_KEY, createCirrus, provideCirrus, useCirrus } from "./cirrus-provider";
export { hydratePreloaded } from "./hydrate-preloaded";
export type {
    ArgsOf,
    CirrusClient,
    FunctionReference,
    MutationCallOptions,
    OptimisticLocalStore,
    OptimisticUpdate,
    Preloaded,
    ReturnOf,
    Unsubscribe,
    UseQueryOptions,
    User,
} from "./types";
export type { MutationHandle } from "./use-mutation";
export { useMutation } from "./use-mutation";
export { subscribeToQuery, useQuery } from "./use-query";
