/**
 * The Angular adapter for Lunora.
 *
 * Thin, idiomatic glue over the framework-neutral `@lunora/client`. Angular
 * signals map directly onto Lunora's per-subscription deltas, so a live query is
 * just a `signal` the WebSocket writes to.
 *
 * `provideLunora` / `LUNORA_CLIENT` / `injectLunoraClient` are the injectable
 * provider carrying one `LunoraClient` (opens its socket lazily), wired once in the
 * application config. `liveQuery` is a live-query `signal` that opens a
 * subscription and updates on every delta, torn down automatically on
 * `DestroyRef.onDestroy`. `mutate` runs a mutation (optimistic updates + offline
 * queue pass through to the client). `connectionStatus` is a `signal` of the
 * aggregate live-socket status.
 *
 * The API is deliberately small and signal-first; parity extras (paginated query,
 * optimistic mutator handles, rate-limit, flags, auth) mirror the other framework
 * adapters and can be layered on top of the same client.
 */
export type { ProvideLunoraOptions } from "./client";
export { injectLunoraClient, LUNORA_CLIENT, provideLunora } from "./client";
export type { ConnectionStatusOptions } from "./connection-status";
export { connectionStatus } from "./connection-status";
export type { LiveQueryOptions } from "./live-query";
export { liveQuery } from "./live-query";
export type { MutateOptions } from "./mutate";
export { mutate } from "./mutate";
export type {
    ArgsOf,
    ConnectionStatus,
    FunctionReference,
    LunoraClient,
    LunoraClientOptions,
    MutationCallOptions,
    ReturnOf,
    SubscriptionError,
    Unsubscribe,
} from "@lunora/client";
// Re-export the core client contract so consumers can stay on a single import for
// function references, args/return inference, connection status, and the `"skip"`
// live-query sentinel.
export { SKIP } from "@lunora/client/query";
