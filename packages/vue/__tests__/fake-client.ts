import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, StreamHandle, StreamIterable, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import { createStream } from "@lunora/client";
import { vi } from "vitest";
import { createApp } from "vue";

import { LUNORA_INJECTION_KEY } from "../src/lunora-provider";

interface SubscribeCall {
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
    functionPath: string;
    options: { onError?: SubscriptionErrorCallback; shardKey?: string };
}

interface StreamCall {
    args: Record<string, unknown>;
    functionPath: string;
    /** The producer side — drive the stream with `handle.push`/`complete`/`fail`. */
    handle: StreamHandle;
    /** The consumer iterable handed back to the composable. */
    iterable: StreamIterable<unknown>;
    /** Spy invoked when the composable cancels its iterator (teardown). */
    onCancel: ReturnType<typeof vi.fn>;
    options: { durable?: boolean; maxBuffer?: number; shardKey?: string };
}

/**
 * A hand-rolled stand-in for `LunoraClient` exposing just the surface the Vue
 * composables touch (`subscribe`, `mutation`, `stream`). Records every subscribe
 * and stream call, lets a test push values to a live subscription or stream, and
 * spies on unsubscribe / cancel so we can assert teardown. No WebSocket, no
 * network — pure in-memory.
 */
interface FakeClient {
    /** A recorded mock of `action` so tests can assert calls/resolve a value. */
    actionSpy: ReturnType<typeof vi.fn>;
    /** The fake typed as a `LunoraClient` for passing into the composables. */
    client: LunoraClient;
    /** Await a macrotask so the stream consumer's `for await` loop drains queued chunks into `chunks`. */
    flush: () => Promise<void>;
    /** A recorded mock of `mutation` so tests can assert calls/resolve a value. */
    mutationSpy: ReturnType<typeof vi.fn>;
    /** Run `fn` with this fake provided as the Lunora client (no component mount). */
    provide: <T>(fn: () => T) => T;
    /** Push `value` to every callback subscribed for `(functionPath, args)`. */
    push: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Push a chunk to every open stream matching `(functionPath, args)`. */
    pushStream: (functionPath: string, args: Record<string, unknown>, value: unknown) => void;
    /** Every `stream` call made against the fake, in order. */
    streamCalls: StreamCall[];
    /** Every `subscribe` call made against the fake, in order. */
    subscribeCalls: SubscribeCall[];
    /** Spy invoked each time a subscription's returned `Unsubscribe` runs. */
    unsubscribeSpy: ReturnType<typeof vi.fn>;
}

const keyOf = (functionPath: string, args: Record<string, unknown>): string => `${functionPath}::${JSON.stringify(args)}`;

const createFakeClient = (): FakeClient => {
    const subscribeCalls: SubscribeCall[] = [];
    const streamCalls: StreamCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();
    const mutationSpy = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);
    const actionSpy = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined);

    // A throwaway Vue app gives us a real `runWithContext` so `inject`/`provide`
    // resolve without mounting a component into a DOM.
    const app = createApp({});

    const subscribe = <F extends FunctionReference>(
        function_: F,
        args: ArgsOf<F>,
        callback: (data: ReturnOf<F>) => void,
        options: { onError?: SubscriptionErrorCallback; shardKey?: string } = {},
    ): Unsubscribe => {
        subscribeCalls.push({
            args: args ?? {},
            callback: callback as (data: unknown) => void,
            // Bracket access — this package's eslint config has no underscore
            // allow-list, and `__lunoraRef` is the real public marker field.
            functionPath: function_["__lunoraRef"],
            options,
        });

        return () => {
            unsubscribeSpy();
        };
    };

    const stream = <F extends FunctionReference<"stream">>(
        function_: F,
        args: ArgsOf<F>,
        options: { durable?: boolean; maxBuffer?: number; shardKey?: string } = {},
    ): StreamIterable<ReturnOf<F>> => {
        const onCancel = vi.fn<() => void>();
        const { handle, iterable } = createStream<unknown>({ maxBuffer: options.maxBuffer, onCancel });

        streamCalls.push({
            args: args ?? {},
            functionPath: function_["__lunoraRef"],
            handle,
            iterable,
            onCancel,
            options,
        });

        return iterable as StreamIterable<ReturnOf<F>>;
    };

    const fake = { action: actionSpy, mutation: mutationSpy, stream, subscribe } as unknown as LunoraClient;

    // Install the fake into the app's provide context up front so
    // `useLunora()` resolves it inside `runWithContext`.
    app.provide(LUNORA_INJECTION_KEY, fake);

    const provide = <T>(fn: () => T): T => app.runWithContext(fn);

    const push = (functionPath: string, args: Record<string, unknown>, value: unknown): void => {
        const target = keyOf(functionPath, args);

        for (const call of subscribeCalls) {
            if (keyOf(call.functionPath, call.args) === target) {
                call.callback(value);
            }
        }
    };

    const pushStream = (functionPath: string, args: Record<string, unknown>, value: unknown): void => {
        const target = keyOf(functionPath, args);

        for (const call of streamCalls) {
            if (keyOf(call.functionPath, call.args) === target) {
                call.handle.push(value);
            }
        }
    };

    // The stream consumer drains its queue across microtasks; a macrotask hop
    // guarantees every buffered chunk has landed in the composable's `chunks` ref.
    const flush = (): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

    return { actionSpy, client: fake, flush, mutationSpy, provide, push, pushStream, streamCalls, subscribeCalls, unsubscribeSpy };
};

export type { FakeClient };
export { createFakeClient };
