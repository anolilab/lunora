/**
 * `@lunora/client/query` — the framework-neutral live-query state machine shared
 * by every Lunora UI adapter (React, Vue, Svelte, Solid). It owns the seam
 * between a `LunoraClient` subscription and a framework's reactivity primitive:
 * the subscribe → snapshot → error/reset → cleanup lifecycle, with the
 * skip-handling, value/error fan-out, attach-throw normalisation, and
 * cancellation-guarded teardown all in one place. Nothing here imports a UI
 * framework — each adapter supplies thin sinks that write into its own ref /
 * store / signal / cache.
 *
 * It also owns the TanStack Query key contract (`lunoraQueryKey`,
 * `lunoraQueryOptions`), so every adapter and server entry keys a Lunora query
 * the same way.
 */

// Re-export the client contract every adapter needs so they can depend on
// this entry for the shared types too.
export type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "../index";
export type { LunoraQueryKey, LunoraQueryOptions } from "./query-options";
export { lunoraQueryKey, lunoraQueryKeyFromArgsKey, lunoraQueryOptions } from "./query-options";
export type { QuerySubscriptionOptions, QuerySubscriptionSinks, ResolvedArgs } from "./query-subscription";
export { createQuerySubscription, SKIP, toSubscriptionError } from "./query-subscription";
