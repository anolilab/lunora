export { LunoraContext, useLunora } from "./context";
export type { AgentThreadRecord, AgentThreadStatus, CreateAgentApi, CreateAgentOptions, CreateAgentResult } from "./create-agent";
export { createAgent } from "./create-agent";
export type {
    AgentChatMessage,
    AgentLiveEvent,
    AgentProgressEvent,
    AgentTokenDelta,
    CreateAgentChatApi,
    CreateAgentChatOptions,
    CreateAgentChatResult,
} from "./create-agent-chat";
export { createAgentChat } from "./create-agent-chat";
export type { CreateAgentStateApi, CreateAgentStateOptions, CreateAgentStateResult } from "./create-agent-state";
export { createAgentState } from "./create-agent-state";
export type { AgentToolEvent, CreateAgentToolEventsApi, CreateAgentToolEventsOptions, CreateAgentToolEventsResult } from "./create-agent-tool-events";
export { createAgentToolEvents } from "./create-agent-tool-events";
export type { UseAuthResult } from "./create-auth";
export { Authenticated, AuthLoading, createAuth, Unauthenticated } from "./create-auth";
export { default as createConnectionStatus } from "./create-connection-status";
export type { FlagContext, FlagValue } from "./create-flag";
export { createFlag, createFlags } from "./create-flag";
export type { MutationClient, MutationHandle } from "./create-mutation";
export { createMutation, createMutationForClient } from "./create-mutation";
export type { MutatorHandle, MutatorHook, MutatorTransaction } from "./create-mutator";
export { createMutator } from "./create-mutator";
export type {
    CreateInfiniteQueryOptions,
    CreateInfiniteQueryResult,
    CreatePaginatedQueryOptions,
    CreatePaginatedQueryResult,
    PageItemOf,
    PaginatedArgs,
} from "./create-paginated-query";
export { createInfiniteQuery, createPaginatedQuery } from "./create-paginated-query";
export type { CreatePresenceOptions, CreatePresenceResult, HeartbeatReference, ListPresentReference } from "./create-presence";
export { createPresence } from "./create-presence";
export type { CreateQueryOptions } from "./create-query";
export { createQuery } from "./create-query";
export type { CreateRateLimitOptions, CreateRateLimitResult } from "./create-rate-limit";
export { createRateLimit } from "./create-rate-limit";
export type { CreateStreamOptions, CreateStreamResult, CreateStreamStatus } from "./create-stream";
export { createStream } from "./create-stream";
export type { CreateSubscriptionResult } from "./create-subscription";
export { createSubscription } from "./create-subscription";
export type { CreateVoiceAgentOptions, CreateVoiceAgentResult, VoiceAudioFormat, VoiceReference, VoiceStatus } from "./create-voice-agent";
export { createVoiceAgent } from "./create-voice-agent";
export { default as hydratePreloaded } from "./hydrate-preloaded";

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
// Re-export the core type surface so consumers can stay on a single import for
// function references, args/return inference, and the SSR `Preloaded` token.
export type { ArgsOf, FunctionReference, OptimisticUpdate, Preloaded, ReturnOf, Unsubscribe } from "@lunora/client";
