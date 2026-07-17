"use client";

// The hook/provider exports in this barrel are client-side — they call
// `useState`/`useEffect`/`use(...)` and own a live WS connection, so each source
// module here declares `"use client"` and is meant to run only in Client
// Components. In a Next.js / RSC app, import these from your own `"use client"`
// files (see the provider/hook examples in the docs); server-side data loading
// lives in the socket-free `@lunora/react/server` entry. The framework-neutral
// error discriminators re-exported from `@lunora/client` at the bottom are pure
// helpers (no hooks) surfaced here so a React-only user gets them in one import.
export { Authenticated, AuthLoading, Unauthenticated } from "./auth-gates";
export type { AuthState } from "./auth-state";
export { useAuthState } from "./auth-state";
export type { LunoraProviderProps } from "./lunora-provider";
export { LunoraProvider, useLunora } from "./lunora-provider";
export type { CheckoutButtonProps, CustomerPortalButtonProps, RedirectTarget, RedirectTrigger, Subscription, UseCheckoutResult } from "./payment";
export { CheckoutButton, CustomerPortalButton, useCheckout } from "./payment";
export type { LunoraQueryOptions } from "./query-options";
export { lunoraQueryOptions } from "./query-options";
export type {
    ArgsOf,
    FunctionReference,
    HttpStreamArgsOf,
    HttpStreamChunkOf,
    HttpStreamRef,
    LunoraClient,
    OptimisticLocalStore,
    OptimisticUpdate,
    PaginationResult,
    PaginationStatus,
    Preloaded,
    ReturnOf,
    UseAuthResult,
    UseInfiniteQueryOptions,
    UseInfiniteQueryResult,
    UseMutationCallOptions,
    UsePaginatedQueryOptions,
    UsePaginatedQueryResult,
    UseQueryOptions,
    User,
    UseSubscriptionResult,
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
export { default as useAuth } from "./use-auth";
export { default as useClientQuery } from "./use-client-query";
export { default as useConnectionStatus } from "./use-connection-status";
export type { FlagContext, FlagValue } from "./use-flag";
export { useFlag, useFlags } from "./use-flag";
export type { UseHttpStreamOptions, UseHttpStreamResult } from "./use-http-stream";
export { useHttpStream } from "./use-http-stream";
export { default as useInfiniteQuery } from "./use-infinite-query";
export type { MutationHook } from "./use-mutation";
export { useMutation } from "./use-mutation";
export type { MutatorHandle, MutatorHook, MutatorTransaction } from "./use-mutator";
export { useMutator } from "./use-mutator";
export type { PageItemOf, PaginatedArgs } from "./use-paginated-query";
export { usePaginatedQuery } from "./use-paginated-query";
export { hydratePreloaded, default as usePreloadedQuery } from "./use-preloaded-query";
export type { HeartbeatReference, ListPresentReference, UsePresenceOptions, UsePresenceResult } from "./use-presence";
export { usePresence } from "./use-presence";
export { default as useQuery } from "./use-query";
export type { UseRateLimitOptions, UseRateLimitResult } from "./use-rate-limit";
export { useRateLimit } from "./use-rate-limit";
export type { UseStreamOptions, UseStreamResult, UseStreamStatus } from "./use-stream";
export { useStream } from "./use-stream";
export { default as useSubscription } from "./use-subscription";
export type { UseVoiceAgentOptions, UseVoiceAgentResult, VoiceAudioFormat, VoiceReference, VoiceStatus } from "./use-voice-agent";
export { useVoiceAgent } from "./use-voice-agent";

// Framework-neutral error discriminators re-exported from `@lunora/client` so a
// React-only user gets them without a second import (see the header note).
export type { LunoraErrorCode } from "@lunora/client";
export { getErrorCode, getRetryAfterMs, isConflictError, isForbiddenError, isRateLimitedError, isUnauthorizedError } from "@lunora/client";

// Local client-query refs — the createClientQuery factory + the ref type are
// re-exported so a React-only user imports everything from one package.
export type { ClientQueryRef } from "@lunora/client";
export { createClientQuery } from "@lunora/client";
