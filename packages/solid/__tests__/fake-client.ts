/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field the wire types expose; fixtures mirror it verbatim. */
import type { LunoraClient, FunctionReference, Unsubscribe } from "@lunora/client";

/**
 * A minimal stand-in for `LunoraClient` exposing just the surface the Solid
 * adapter touches (`subscribe` / `mutation`). It records subscriptions and lets a
 * test push values to the live callback, so we can assert the synchronous seed
 * vs. the later live update without a real WebSocket.
 */
export interface FakeSubscription {
    args: Record<string, unknown>;
    functionPath: string;
    push: (value: unknown) => void;
    shardKey?: string;
    unsubscribed: boolean;
}

export interface FakeClient {
    /** As a typed `LunoraClient` for passing through the provider. */
    asClient: LunoraClient;
    mutationCalls: { args: unknown; functionPath: string }[];
    /** Resolve the next `mutation()` with this value (default: echoes args). */
    setMutationResult: (value: unknown) => void;
    /** Reject the next `mutation()` with this error. */
    setMutationThrow: (error: Error) => void;
    subscriptions: FakeSubscription[];
}

export const createFakeClient = (): FakeClient => {
    const subscriptions: FakeSubscription[] = [];
    const mutationCalls: { args: unknown; functionPath: string }[] = [];

    let mutationResult: unknown;
    let mutationThrow: Error | undefined;

    const client = {
        mutation: (function_: FunctionReference, args: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef });

            if (mutationThrow) {
                return Promise.reject(mutationThrow);
            }

            return Promise.resolve(mutationResult ?? args);
        },
        subscribe: (
            function_: FunctionReference,
            args: Record<string, unknown>,
            callback: (data: unknown) => void,
            options?: { shardKey?: string },
        ): Unsubscribe => {
            const sub: FakeSubscription = {
                args,
                functionPath: function_.__lunoraRef,
                push: callback,
                shardKey: options?.shardKey,
                unsubscribed: false,
            };

            subscriptions.push(sub);

            return () => {
                sub.unsubscribed = true;
            };
        },
    };

    return {
        asClient: client as unknown as LunoraClient,
        mutationCalls,
        setMutationResult: (value: unknown) => {
            mutationResult = value;
        },
        setMutationThrow: (error: Error) => {
            mutationThrow = error;
        },
        subscriptions,
    };
};
