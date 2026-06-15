/**
 * Svelte adapter for Lunora (`@lunora/svelte`).
 *
 * Thin, idiomatic glue over the framework-neutral `@lunora/client` (no React):
 * live readable stores you read with `$store`, an optimistic mutation helper,
 * and the reactive-loader handoff (`hydratePreloaded`). The contract mirrors
 * `@lunora/react`, re-expressed in Svelte stores: `setLunoraClient` /
 * `getLunoraClient` are the context provider/consumer; `query` is a live
 * readable store (React's `useQuery`); `mutation` is an optimistic
 * `{ data, error, pending, mutate, reset }` (React's `useMutation`); and
 * `hydratePreloaded` is the SSR-seed-to-live-store handoff (React's
 * `usePreloadedQuery`).
 *
 * The package is plain `.ts` over stores — no `.svelte` component compiler is
 * required to build or test it.
 *
 * Server-side preload helpers (`createServerClient`, `preloadQuery`) live in the
 * socket-free `@lunora/svelte/server` entry (a re-export of `@lunora/client/ssr`, the
 * framework-neutral server contract) — import them there in your SvelteKit
 * `+page.ts` / `+layout.ts` load.
 */
export { getLunoraClient, setLunoraClient } from "./context";
export { default as hydratePreloaded } from "./hydrate-preloaded";
export type { MutationHandle } from "./mutation";
export { mutation } from "./mutation";
export type { QueryStore, QueryStoreOptions } from "./query";
export { query } from "./query";
// Re-export the core types adapters lean on, so consumers import them from one place.
export type { ArgsOf, LunoraClient, FunctionReference, MutationCallOptions, Preloaded, ReturnOf } from "@lunora/client";
