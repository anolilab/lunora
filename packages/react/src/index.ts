"use client";

// Every export in this barrel is a client-side hook or the context provider —
// they call `useState`/`useEffect`/`use(...)` and own a live WS connection, so
// each source module here declares `"use client"` and is meant to run only in
// Client Components. In a Next.js / RSC app, import these from your own
// `"use client"` files (see the provider/hook examples in the docs); server-side
// data loading lives in the socket-free `@lunora/react/server` entry.
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
export { default as useAuth } from "./use-auth";
export { default as useConnectionStatus } from "./use-connection-status";
export type { FlagContext, FlagValue } from "./use-flag";
export { useFlag, useFlags } from "./use-flag";
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
