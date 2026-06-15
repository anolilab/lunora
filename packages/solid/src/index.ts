/**
 * SolidJS adapter for Lunora.
 *
 * Thin, idiomatic glue over the framework-neutral `@lunora/client`. Solid's
 * fine-grained signals map directly onto Lunora's per-subscription deltas, so a
 * live query is just a signal the WebSocket writes to. The adapter exposes
 * `LunoraProvider` / `useLunora` (context carrying the `LunoraClient`),
 * `createQuery` (a live query accessor that opens a subscription and updates on
 * every delta), `createMutation` (an optimistic mutation handle), and
 * `hydratePreloaded` (seed a query from an SSR `Preloaded` token synchronously —
 * no loading flash — then attach the live subscription; the client half of
 * PLAN4's "your loaders are live" reactive-loader handoff).
 *
 * Server-side preloading (`createServerClient`, `preloadQuery`) lives in the
 * socket-free `@lunora/solid/server` entry (a re-export of `@lunora/client/ssr`, the
 * framework-neutral server contract) — call it from your SolidStart route loader
 * and hand the resulting `Preloaded` token to `hydratePreloaded`.
 */
export type { LunoraProviderProps } from "./lunora-provider";
export { LunoraProvider } from "./lunora-provider";
export { LunoraContext, useLunora } from "./context";
export type { MutationClient, MutationHandle } from "./create-mutation";
export { createMutation, createMutationForClient } from "./create-mutation";
export type { CreateQueryOptions } from "./create-query";
export { createQuery } from "./create-query";
export { default as hydratePreloaded } from "./hydrate-preloaded";

// Re-export the core type surface so consumers can stay on a single import for
// function references, args/return inference, and the SSR `Preloaded` token.
export type { ArgsOf, FunctionReference, OptimisticUpdate, Preloaded, ReturnOf, Unsubscribe } from "@lunora/client";
