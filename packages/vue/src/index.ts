export { Authenticated, AuthLoading, Unauthenticated } from "./auth-gates";
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
    PaginationResult,
    PaginationStatus,
    Preloaded,
    ReturnOf,
    Unsubscribe,
    UseQueryOptions,
    User,
} from "./types";
export type { AgentThreadRecord, AgentThreadStatus, UseAgentApi, UseAgentOptions, UseAgentResult } from "./use-agent";
export { useAgent } from "./use-agent";
export type {
    AgentChatMessage,
    AgentLiveEvent,
    AgentProgressEvent,
    AgentTokenDelta,
    UseAgentChatApi,
    UseAgentChatOptions,
    UseAgentChatResult,
} from "./use-agent-chat";
export { useAgentChat } from "./use-agent-chat";
export type { UseAgentStateApi, UseAgentStateOptions, UseAgentStateResult } from "./use-agent-state";
export { useAgentState } from "./use-agent-state";
export type { AgentToolEvent, UseAgentToolEventsApi, UseAgentToolEventsOptions, UseAgentToolEventsResult } from "./use-agent-tool-events";
export { useAgentToolEvents } from "./use-agent-tool-events";
export type { UseAuthResult } from "./use-auth";
export { useAuth } from "./use-auth";
export { default as useConnectionStatus } from "./use-connection-status";
export type { FlagContext, FlagValue } from "./use-flag";
export { useFlag, useFlags } from "./use-flag";
export type { MutationHandle } from "./use-mutation";
export { useMutation } from "./use-mutation";
export type { MutatorHandle, MutatorHook, MutatorTransaction } from "./use-mutator";
export { useMutator } from "./use-mutator";
export type {
    PageItemOf,
    PaginatedArgs,
    UseInfiniteQueryOptions,
    UseInfiniteQueryResult,
    UsePaginatedQueryOptions,
    UsePaginatedQueryResult,
} from "./use-paginated-query";
export { useInfiniteQuery, usePaginatedQuery } from "./use-paginated-query";
export type { HeartbeatReference, ListPresentReference, UsePresenceOptions, UsePresenceResult } from "./use-presence";
export { usePresence } from "./use-presence";
export { subscribeToQuery, useQuery } from "./use-query";
export type { UseRateLimitOptions, UseRateLimitResult } from "./use-rate-limit";
export { useRateLimit } from "./use-rate-limit";
export type { UseStreamOptions, UseStreamResult, UseStreamStatus } from "./use-stream";
export { useStream } from "./use-stream";
export type { UseSubscriptionResult } from "./use-subscription";
export { useSubscription } from "./use-subscription";
export type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceAudioFormat, VoiceReference, VoiceStatus } from "./use-voice-agent";
export { useVoiceAgent } from "./use-voice-agent";
