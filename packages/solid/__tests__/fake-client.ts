/* eslint-disable no-underscore-dangle -- `__lunoraRef` is the Lunora function-reference field the wire types expose; fixtures mirror it verbatim. */
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, StreamHandle, StreamIterable, Unsubscribe } from "@lunora/client";
import { createStream } from "@lunora/client";
import { vi } from "vitest";

const keyOf = (functionPath: string, args: Record<string, unknown>): string => `${functionPath}::${JSON.stringify(args)}`;

/**
 * A minimal stand-in for `LunoraClient` exposing just the surface the Solid
 * adapter touches (`subscribe` / `mutation` / `stream`). It records subscriptions
 * and stream calls and lets a test push values to the live callback, so we can
 * assert the synchronous seed vs. the later live update without a real WebSocket.
 */
export interface FakeSubscription {
    args: Record<string, unknown>;
    /** Push a subscription-scoped error to the live `onError` sink (no-op if none registered). */
    error: (error: { code?: string; message: string }) => void;
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
    /** Spy invoked when the primitive cancels its iterator (teardown / args change). */
    onCancel: ReturnType<typeof vi.fn>;
    options: { durable?: boolean; maxBuffer?: number; shardKey?: string };
}

export interface FakeClient {
    /** As a typed `LunoraClient` for passing through the provider. */
    asClient: LunoraClient;
    /** Await a macrotask so a stream consumer's `for await` loop drains queued chunks into its signal. */
    flush: () => Promise<void>;
    mutationCalls: { args: unknown; functionPath: string }[];
    /** Push a chunk to every open stream matching `(functionPath, args)`. */
    pushStream: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Set the auth token (and optionally the subject) — fires `onAuthTokenChange`. */
    setAuthToken: (token: string | null, subject?: string | null) => void;
    /** Resolve the next `mutation()` with this value (default: echoes args). */
    setMutationResult: (value: unknown) => void;
    /** Reject the next `mutation()` with this error. */
    setMutationThrow: (error: Error) => void;
    /** Every `stream` call made against the fake, in order. */
    streamCalls: FakeStreamCall[];
    subscriptions: FakeSubscription[];
}

export const createFakeClient = (): FakeClient => {
    const subscriptions: FakeSubscription[] = [];
    const streamCalls: FakeStreamCall[] = [];
    const mutationCalls: { args: unknown; functionPath: string }[] = [];

    let mutationResult: unknown;
    let mutationThrow: Error | undefined;

    // Auth-identity surface the voice primitive's `watchVoiceIdentity` reads: it
    // keys on the identity FINGERPRINT (subject when supplied, else the token), so
    // a same-subject JWT refresh fires the listeners without moving the identity.
    let authToken: string | null = null;
    let authSubject: string | null | undefined;
    const authTokenListeners = new Set<(token: string | null) => void>();
    const setAuthTokenFake = (token: string | null, subject?: string | null): void => {
        if (subject !== undefined) {
            authSubject = subject;
        } else if (token === null) {
            authSubject = undefined;
        }

        if (authToken === token) {
            return;
        }

        authToken = token;

        for (const listener of authTokenListeners) {
            listener(token);
        }
    };

    const client = {
        currentIdentity: (): string | null => authSubject ?? authToken,
        getAuthToken: (): string | null => authToken,
        onAuthTokenChange: (listener: (token: string | null) => void): Unsubscribe => {
            authTokenListeners.add(listener);

            return () => {
                authTokenListeners.delete(listener);
            };
        },
        setAuthToken: setAuthTokenFake,
        mutation: (function_: FunctionReference, args: unknown) => {
            mutationCalls.push({ args, functionPath: function_.__lunoraRef });

            if (mutationThrow) {
                return Promise.reject(mutationThrow);
            }

            return Promise.resolve(mutationResult ?? args);
        },
        stream: <F extends FunctionReference<"stream">>(
            function_: F,
            args: ArgsOf<F>,
            options: { durable?: boolean; maxBuffer?: number; shardKey?: string } = {},
        ): StreamIterable<ReturnOf<F>> => {
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

            return iterable as StreamIterable<ReturnOf<F>>;
        },
        subscribe: (
            function_: FunctionReference,
            args: Record<string, unknown>,
            callback: (data: unknown) => void,
            options?: { onError?: (error: { code?: string; message: string }) => void; shardKey?: string },
        ): Unsubscribe => {
            const sub: FakeSubscription = {
                args,
                error: (error) => options?.onError?.(error),
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

    const pushStream = (functionPath: string, args: Record<string, unknown>, value: unknown): void => {
        const target = keyOf(functionPath, args);

        for (const call of streamCalls) {
            if (keyOf(call.functionPath, call.args) === target) {
                call.handle.push(value);
            }
        }
    };

    // A stream consumer drains its queue across microtasks; a macrotask hop
    // guarantees every buffered chunk has landed in the primitive's `chunks` signal.
    const flush = (): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

    return {
        asClient: client as unknown as LunoraClient,
        flush,
        mutationCalls,
        pushStream,
        setAuthToken: setAuthTokenFake,
        setMutationResult: (value: unknown) => {
            mutationResult = value;
        },
        setMutationThrow: (error: Error) => {
            mutationThrow = error;
        },
        streamCalls,
        subscriptions,
    };
};
