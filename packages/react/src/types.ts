import type { User } from "@cirrus/client";

export interface UseQueryOptions {
    shardKey?: string;
}

export interface UseMutationCallOptions<TCurrent = unknown, TValue = unknown> {
    optimistic?: (current: TCurrent | undefined) => TValue;
    shardKey?: string;
}

export interface UseSubscriptionResult<T> {
    data: T | undefined;
    error: Error | undefined;
}

export interface UseAuthResult {
    setToken: (token: string | null) => void;
    token: string | null;
    user: User | null;
}

export { type ArgsOf, type CirrusClient, type FunctionReference, type ReturnOf, type User } from "@cirrus/client";
