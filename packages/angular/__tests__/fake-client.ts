/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field the wire types expose; fixtures mirror it verbatim. */
import type { DestroyRef } from "@angular/core";
import type { ConnectionStatus, FunctionReference, LunoraClient, StreamHandle, StreamIterable, SubscriptionError, Unsubscribe, User } from "@lunora/client";
import { createStream } from "@lunora/client";
import { vi } from "vitest";

/**
 * A minimal stand-in for `LunoraClient` exposing just the surface the Angular
 * adapter touches (`subscribe` / `mutation` / `connectionStatus` /
 * `onConnectionStatus` / auth / connection-context). It records subscriptions and lets a test push values to
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

export interface FakeStreamCall {
    args: Record<string, unknown>;
    functionPath: string;
    /** The producer side — drive the stream with `handle.push`/`complete`/`fail`. */
    handle: StreamHandle;
    /** The consumer iterable handed back to the primitive. */
    iterable: StreamIterable<unknown>;
    /** Spy invoked when the primitive cancels its iterator (teardown). */
    onCancel: ReturnType<typeof vi.fn>;
    options?: { durable?: boolean; maxBuffer?: number; shardKey?: string };
}

export interface FakeConnectionContext {
    context: { roomId: string; sessionId: string };
    released: boolean;
    shardKey?: string;
}

export interface FakeClient {
    /** Every `action()` call made against the fake, in order. */
    actionCalls: { args: unknown; functionPath: string; options: unknown }[];
    /** As a typed `LunoraClient` for passing through `liveQuery` / `mutate` / `runAction`. */
    asClient: LunoraClient;
    /** Connection contexts acquired via `acquireConnectionContext`. */
    connectionContexts: FakeConnectionContext[];
    /** Drive the auth-token listeners (fires `onAuthTokenChange` callbacks). */
    emitAuthTokenChange: () => void;
    /** Drive the connection-status listeners. */
    emitStatus: (status: ConnectionStatus) => void;
    /** Await a macrotask so the stream consumer's `for await` loop drains queued chunks into `chunks`. */
    flush: () => Promise<void>;
    mutationCalls: { args: unknown; functionPath: string; options: unknown }[];
    /** Push `value` to every subscription callback registered for `(functionPath, args)`. */
    push: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Push a chunk to every open stream matching `(functionPath, args)`. */
    pushStream: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Resolve the next `action()` with this value (default: echoes args). */
    setActionResult: (value: unknown) => void;
    /** Reject the next `action()` with this error. */
    setActionThrow: (error: Error) => void;
    /** Set the user that `getCurrentUser()` resolves with. */
    setCurrentUser: (user: User | null) => void;
    /** Resolve the next `mutation()` with this value (default: echoes args). */
    setMutationResult: (value: unknown) => void;
    /** Reject the next `mutation()` with this error. */
    setMutationThrow: (error: Error) => void;
    statusListeners: ((status: ConnectionStatus) => void)[];
    /** Every `stream` call made against the fake, in order. */
    streamCalls: FakeStreamCall[];
    subscriptions: FakeSubscription[];
    /** Auth-token listeners registered via `onAuthTokenChange`. */
    tokenListeners: (() => void)[];
}

export const createFakeClient = (initialStatus: ConnectionStatus = "idle"): FakeClient => {
    const subscriptions: FakeSubscription[] = [];
    const streamCalls: FakeStreamCall[] = [];
    const mutationCalls: { args: unknown; functionPath: string; options: unknown }[] = [];
    const actionCalls: { args: unknown; functionPath: string; options: unknown }[] = [];
    const statusListeners: ((status: ConnectionStatus) => void)[] = [];
    const tokenListeners: (() => void)[] = [];
    const connectionContexts: FakeConnectionContext[] = [];

    // Match a `(functionPath, args)` pair against recorded subscriptions/streams.
    const keyOf = (functionPath: string, args: Record<string, unknown>): string => `${functionPath}::${JSON.stringify(args)}`;

    let mutationResult: unknown;
    let mutationThrow: Error | undefined;
    let actionResult: unknown;
    let actionThrow: Error | undefined;
    let status = initialStatus;
    let authToken: string | null = null;
    let currentUser: User | null = null;

    const client = {
        action: (function_: FunctionReference, args: unknown, options: unknown) => {
            actionCalls.push({ args, functionPath: function_.__lunoraRef, options });

            if (actionThrow) {
                return Promise.reject(actionThrow);
            }

            return Promise.resolve(actionResult ?? args);
        },
        acquireConnectionContext: (context: { roomId: string; sessionId: string }, options?: { shardKey?: string }) => {
            const entry: FakeConnectionContext = { context, released: false, shardKey: options?.shardKey };
            connectionContexts.push(entry);

            return () => {
                entry.released = true;
            };
        },
        connectionStatus: (): ConnectionStatus => status,
        getAuthToken: () => authToken,
        getCurrentUser: () => Promise.resolve(currentUser),
        mutation: (function_: FunctionReference, args: unknown, options: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef, options });

            if (mutationThrow) {
                return Promise.reject(mutationThrow);
            }

            return Promise.resolve(mutationResult ?? args);
        },
        onAuthTokenChange: (listener: () => void): Unsubscribe => {
            tokenListeners.push(listener);

            return () => {
                const index = tokenListeners.indexOf(listener);

                if (index !== -1) {
                    tokenListeners.splice(index, 1);
                }
            };
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
        setAuthToken: (token: string | null) => {
            authToken = token;
        },
        stream: (
            function_: FunctionReference<"stream">,
            args: Record<string, unknown>,
            options: { durable?: boolean; maxBuffer?: number; shardKey?: string } = {},
        ): StreamIterable<unknown> => {
            const onCancel = vi.fn<() => void>();
            const { handle, iterable } = createStream<unknown>({ maxBuffer: options.maxBuffer, onCancel });

            streamCalls.push({
                args: args ?? {},
                functionPath: function_.__lunoraRef,
                handle,
                iterable,
                onCancel,
                options,
            });

            return iterable;
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
        actionCalls,
        asClient: client as unknown as LunoraClient,
        connectionContexts,
        emitAuthTokenChange: () => {
            for (const listener of tokenListeners) {
                listener();
            }
        },
        emitStatus: (next: ConnectionStatus) => {
            status = next;

            for (const listener of statusListeners) {
                listener(next);
            }
        },
        // The stream consumer drains its queue across microtasks; a macrotask hop
        // guarantees every buffered chunk has landed in the primitive's `chunks` signal.
        flush: (): Promise<void> =>
            new Promise((resolve) => {
                setTimeout(resolve, 0);
            }),
        mutationCalls,
        push: (functionPath: string, args: Record<string, unknown>, value: unknown) => {
            const target = keyOf(functionPath, args);

            for (const sub of subscriptions) {
                if (keyOf(sub.functionPath, sub.args) === target) {
                    sub.push(value);
                }
            }
        },
        pushStream: (functionPath: string, args: Record<string, unknown>, value: unknown) => {
            const target = keyOf(functionPath, args);

            for (const call of streamCalls) {
                if (keyOf(call.functionPath, call.args) === target) {
                    call.handle.push(value);
                }
            }
        },
        setCurrentUser: (user: User | null) => {
            currentUser = user;
        },
        setActionResult: (value: unknown) => {
            actionResult = value;
        },
        setActionThrow: (error: Error) => {
            actionThrow = error;
        },
        setMutationResult: (value: unknown) => {
            mutationResult = value;
        },
        setMutationThrow: (error: Error) => {
            mutationThrow = error;
        },
        statusListeners,
        streamCalls,
        subscriptions,
        tokenListeners,
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
