export { hydratePreloaded } from "./hydrate-preloaded";

/**
 * `@lunora/vue` — the Vue adapter for Lunora.
 *
 * Thin, idiomatic glue over the framework-neutral `@lunora/client` (which owns
 * the WebSocket transport, subscription registry, offline queue, and
 * delta-merge — zero React, zero Vue). This package re-expresses that contract
 * as Vue composables:
 *
 * - `createLunora` / `provideLunora` / `useLunora` — provide/inject the client.
 * - `useQuery` — a live `ref` that opens a WS subscription and updates on deltas (reactive args re-subscribe).
 * - `useMutation` — an optimistic mutation handle (refs + awaitable `mutate`).
 * - `hydratePreloaded` — seed a `ref` synchronously from an SSR `Preloaded` token (no loading flash), then attach the live subscription.
 *
 * Server-side preload helpers live in the socket-free `@lunora/vue/server`
 * entry (`createServerClient`, `preloadQuery`). Single-worker composition for
 * Nuxt (Class-B: inject Lunora realtime into Nitro's emitted Worker) lives in
 * the Vue-free `@lunora/vue/worker` entry (`withLunora`).
 */
export { createLunora, LUNORA_INJECTION_KEY, provideLunora, useLunora } from "./lunora-provider";
export type {
    ArgsOf,
    FunctionReference,
    LunoraClient,
    MutationCallOptions,
    OptimisticLocalStore,
    OptimisticUpdate,
    Preloaded,
    ReturnOf,
    Unsubscribe,
    UseQueryOptions,
    User,
} from "./types";
export { default as useConnectionStatus } from "./use-connection-status";
export type { MutationHandle } from "./use-mutation";
export { useMutation } from "./use-mutation";
export { subscribeToQuery, useQuery } from "./use-query";
