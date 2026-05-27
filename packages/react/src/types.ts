import type { ArgsOf, CirrusClient, FunctionReference, ReturnOf, User } from "@cirrus/client";

export type { ArgsOf, CirrusClient, FunctionReference, ReturnOf, User };

export interface UseQueryOptions {
    shardKey?: string;
}

export interface UseMutationCallOptions<TCurrent = unknown, TValue = unknown> {
    shardKey?: string;
    optimistic?: (current: TCurrent | undefined) => TValue;
}

export interface UseSubscriptionResult<T> {
    data: T | undefined;
    error: Error | undefined;
}

export interface UseAuthResult {
    user: User | null;
    token: string | null;
    setToken(token: string | null): void;
}
