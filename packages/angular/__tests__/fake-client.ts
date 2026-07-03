/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field the wire types expose; fixtures mirror it verbatim. */
import type { DestroyRef } from "@angular/core";
import type { ConnectionStatus, FunctionReference, LunoraClient, SubscriptionError, Unsubscribe } from "@lunora/client";

/**
 * A minimal stand-in for `LunoraClient` exposing just the surface the Angular
 * adapter touches (`subscribe` / `mutation` / `connectionStatus` /
 * `onConnectionStatus`). It records subscriptions and lets a test push values to
 * the live callback, so we can assert the signal seed vs. the later live update
 * without a real WebSocket.
 */
export interface FakeSubscription {
    args: Record<string, unknown>;
    /** Deliver an async error to the subscription's `onError` channel (no-op if none was wired). */
    emitError: (error: SubscriptionError) => void;
    functionPath: string;
    push: (value: unknown) => void;
    shardKey?: string;
    unsubscribed: boolean;
}

export interface FakeClient {
    /** As a typed `LunoraClient` for passing through `liveQuery` / `mutate`. */
    asClient: LunoraClient;
    /** Drive the connection-status listeners. */
    emitStatus: (status: ConnectionStatus) => void;
    mutationCalls: { args: unknown; functionPath: string; options: unknown }[];
    /** Resolve the next `mutation()` with this value (default: echoes args). */
    setMutationResult: (value: unknown) => void;
    /** Reject the next `mutation()` with this error. */
    setMutationThrow: (error: Error) => void;
    statusListeners: ((status: ConnectionStatus) => void)[];
    subscriptions: FakeSubscription[];
}

export const createFakeClient = (initialStatus: ConnectionStatus = "idle"): FakeClient => {
    const subscriptions: FakeSubscription[] = [];
    const mutationCalls: { args: unknown; functionPath: string; options: unknown }[] = [];
    const statusListeners: ((status: ConnectionStatus) => void)[] = [];

    let mutationResult: unknown;
    let mutationThrow: Error | undefined;
    let status = initialStatus;

    const client = {
        connectionStatus: (): ConnectionStatus => status,
        mutation: (function_: FunctionReference, args: unknown, options: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef, options });

            if (mutationThrow) {
                return Promise.reject(mutationThrow);
            }

            return Promise.resolve(mutationResult ?? args);
        },
        onConnectionStatus: (listener: (next: ConnectionStatus) => void): Unsubscribe => {
            statusListeners.push(listener);

            return () => {
                const index = statusListeners.indexOf(listener);

                if (index !== -1) {
                    statusListeners.splice(index, 1);
                }
            };
        },
        subscribe: (
            function_: FunctionReference,
            args: Record<string, unknown>,
            callback: (data: unknown) => void,
            options?: { onError?: (error: SubscriptionError) => void; shardKey?: string },
        ): Unsubscribe => {
            const sub: FakeSubscription = {
                args,
                emitError: (error: SubscriptionError) => options?.onError?.(error),
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
        emitStatus: (next: ConnectionStatus) => {
            status = next;

            for (const listener of statusListeners) {
                listener(next);
            }
        },
        mutationCalls,
        setMutationResult: (value: unknown) => {
            mutationResult = value;
        },
        setMutationThrow: (error: Error) => {
            mutationThrow = error;
        },
        statusListeners,
        subscriptions,
    };
};

/** Records `onDestroy` callbacks and lets a test fire them to simulate teardown. */
export interface FakeDestroyRef {
    asDestroyRef: DestroyRef;
    /** Invoke every registered `onDestroy` callback (component destroyed). */
    destroy: () => void;
}

export const createFakeDestroyRef = (): FakeDestroyRef => {
    const callbacks: (() => void)[] = [];
    let isDestroyed = false;

    const destroyRef = {
        get destroyed() {
            return isDestroyed;
        },
        onDestroy: (callback: () => void) => {
            callbacks.push(callback);

            return () => {
                const index = callbacks.indexOf(callback);

                if (index !== -1) {
                    callbacks.splice(index, 1);
                }
            };
        },
    };

    return {
        asDestroyRef: destroyRef,
        destroy: () => {
            isDestroyed = true;

            for (const callback of callbacks) {
                callback();
            }
        },
    };
};
