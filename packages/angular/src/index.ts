export type {
    AgentApi,
    AgentChatMessage,
    AgentLiveEvent,
    AgentOptions,
    AgentProgressEvent,
    AgentResult,
    AgentThreadRecord,
    AgentThreadStatus,
    AgentTokenDelta,
} from "./agent";
export { agent } from "./agent";
export type { AgentChatApi, AgentChatOptions, AgentChatResult, AgentTokenStreamReference } from "./agent-chat";
export { agentChat } from "./agent-chat";
export type { AgentStateApi, AgentStateOptions, AgentStateResult } from "./agent-state";
export { agentState } from "./agent-state";
export type { AgentToolEvent, AgentToolEventsApi, AgentToolEventsOptions, AgentToolEventsResult } from "./agent-tool-events";
export { agentToolEvents } from "./agent-tool-events";
export type { AuthOptions, AuthResult } from "./auth";
export { auth } from "./auth";

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
 */
export type { ProvideLunoraOptions } from "./client";
export { injectLunoraClient, LUNORA_CLIENT, provideLunora } from "./client";
export type { ConnectionStatusOptions } from "./connection-status";
export { connectionStatus } from "./connection-status";
export type { FlagContext, FlagOptions, FlagsOptions, FlagValue } from "./flag";
export { flag, flags } from "./flag";
export type { HydratePreloadedOptions, HydratePreloadedResult } from "./hydrate-preloaded";
export { hydratePreloaded } from "./hydrate-preloaded";
export type { LiveQueryOptions } from "./live-query";
export { liveQuery } from "./live-query";
export type { MutateOptions } from "./mutate";
export { mutate } from "./mutate";
export type { MutatorResult } from "./mutator";
export { mutator } from "./mutator";
export type { PaginatedQueryOptions, PaginatedQueryResult } from "./paginated-query";
export type { InfiniteQueryResult } from "./paginated-query";
export { paginatedQuery } from "./paginated-query";
export { infiniteQuery } from "./paginated-query";
export type { HeartbeatReference, ListPresentReference, PresenceOptions, PresenceResult } from "./presence";
export { presence } from "./presence";
export type { RateLimitOptions, RateLimitResult } from "./rate-limit";
export { rateLimit } from "./rate-limit";
export type { StreamOptions, StreamResult, StreamStatus } from "./stream";
export { stream } from "./stream";
export type { SubscriptionOptions, SubscriptionResult } from "./subscription";
export { subscription } from "./subscription";
export type { VoiceAgentOptions, VoiceAgentResult, VoiceAudioFormat, VoiceReference, VoiceStatus } from "./voice-agent";
export { voiceAgent } from "./voice-agent";
export type {
    ArgsOf,
    ConnectionStatus,
    FunctionReference,
    LunoraClient,
    LunoraClientOptions,
    MutationCallOptions,
    Preloaded,
    ReturnOf,
    SubscriptionError,
    Unsubscribe,
} from "@lunora/client";
// Re-export the core client contract so consumers can stay on a single import for
// function references, args/return inference, connection status, and the `"skip"`
// live-query sentinel.
export { SKIP } from "@lunora/client/query";
