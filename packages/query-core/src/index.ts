/**
 * `@cirrus/query-core` — the framework-neutral live-query state machine shared
 * by every Cirrus UI adapter (React, Vue, Svelte, Solid). It owns the seam
 * between a `CirrusClient` subscription and a framework's reactivity primitive:
 * the subscribe → snapshot → error/reset → cleanup lifecycle, with the
 * skip-handling, value/error fan-out, attach-throw normalisation, and
 * cancellation-guarded teardown all in one place. Nothing here imports a UI
 * framework — each adapter supplies thin sinks that write into its own ref /
 * store / signal / cache.
 */

export type { QuerySubscriptionOptions, QuerySubscriptionSinks, ResolvedArgs } from "./query-subscription";
export { createQuerySubscription, SKIP, toSubscriptionError } from "./query-subscription";

// Re-export the client contract every adapter needs so they can depend on
// query-core for the shared types too.
export type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "@cirrus/client";
