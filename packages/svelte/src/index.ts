/**
 * Svelte adapter for Cirrus (`@cirrus/svelte`).
 *
 * Thin, idiomatic glue over the framework-neutral `@cirrus/client` (no React):
 * live readable stores you read with `$store`, an optimistic mutation helper,
 * and the reactive-loader handoff (`hydratePreloaded`). The contract mirrors
 * `@cirrus/react`, re-expressed in Svelte stores: `setCirrusClient` /
 * `getCirrusClient` are the context provider/consumer; `query` is a live
 * readable store (React's `useQuery`); `mutation` is an optimistic
 * `{ mutate, pending }` (React's `useMutation`); and `hydratePreloaded` is the
 * SSR-seed-to-live-store handoff (React's `usePreloadedQuery`).
 *
 * The package is plain `.ts` over stores — no `.svelte` component compiler is
 * required to build or test it.
 *
 * Server-side preload helpers (`createServerClient`, `preloadQuery`) live in
 * `@cirrus/client` today and will move to `@cirrus/ssr` once that package lands
 * in PLAN4 M1; import them from there in your SvelteKit `+page.ts` load.
 */
export { getCirrusClient, setCirrusClient } from "./context";
export { default as hydratePreloaded } from "./hydrate-preloaded";
export type { MutationCallOptions, MutationHandle } from "./mutation";
export { mutation } from "./mutation";
export type { QueryStore, QueryStoreOptions } from "./query";
export { query } from "./query";
// Re-export the core types adapters lean on, so consumers import them from one place.
export type { ArgsOf, CirrusClient, FunctionReference, Preloaded, ReturnOf } from "@cirrus/client";
