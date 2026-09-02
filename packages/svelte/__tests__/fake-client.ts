import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, StreamHandle, StreamIterable, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import { createStream } from "@lunora/client";
import { vi } from "vitest";

interface SubscribeCall {
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
    functionPath: string;
    options: { onError?: SubscriptionErrorCallback; shardKey?: string };
}

interface StreamCall {
    args: Record<string, unknown> | "skip";
    functionPath: string;
    /** The producer side — drive the stream with `handle.push`/`complete`/`fail`. */
    handle: StreamHandle;
    /** The consumer iterable handed back to the primitive. */
    iterable: StreamIterable<unknown>;
    /** Spy invoked when the primitive cancels its iterator (teardown). */
    onCancel: ReturnType<typeof vi.fn>;
    options: { durable?: boolean; maxBuffer?: number; shardKey?: string };
}

/**
 * A hand-rolled stand-in for `LunoraClient` exposing just the surface the Svelte
 * primitives touch (`subscribe`, `mutation`, `stream`). Records every subscribe and
 * stream call, lets a test push values to a live subscription or stream, and spies
 * on unsubscribe / cancel so we can assert teardown. No WebSocket, no network —
 * pure in-memory. Passed explicitly to each primitive (Svelte has no ambient
 * component context to mount into), so pushes key on `functionPath` alone.
 */
interface FakeClient {
    /** The fake typed as a `LunoraClient` for passing into the primitives. */
    client: LunoraClient;
    /** Await a macrotask so the stream consumer's `for await` loop drains queued chunks into `chunks`. */
    flush: () => Promise<void>;
    /** A recorded mock of `mutation` so tests can assert calls/resolve a value. */
    mutationSpy: ReturnType<typeof vi.fn>;
    /** Push `value` to every callback subscribed on `functionPath`. */
    push: (functionPath: string, value: unknown) => void;
    /** Push a chunk to every open stream on `functionPath`. */
    pushStream: (functionPath: string, value: unknown) => void;
    /** Every `stream` call made against the fake, in order. */
    streamCalls: StreamCall[];
    /** Every `subscribe` call made against the fake, in order. */
    subscribeCalls: SubscribeCall[];
    /** Spy invoked each time a subscription's returned `Unsubscribe` runs. */
    unsubscribeSpy: ReturnType<typeof vi.fn>;
}

const createFakeClient = (): FakeClient => {
    const subscribeCalls: SubscribeCall[] = [];
    const streamCalls: StreamCall[] = [];
    const unsubscribeSpy = vi.fn<() => void>();
    const mutationSpy = vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => {
        return { resolved: true };
    });

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

    const fake = { mutation: mutationSpy, stream, subscribe } as unknown as LunoraClient;

    const push = (functionPath: string, value: unknown): void => {
        for (const call of subscribeCalls) {
            if (call.functionPath === functionPath) {
                call.callback(value);
            }
        }
    };

    const pushStream = (functionPath: string, value: unknown): void => {
        for (const call of streamCalls) {
            if (call.functionPath === functionPath) {
                call.handle.push(value);
            }
        }
    };

    // The stream consumer drains its queue across microtasks; a macrotask hop
    // guarantees every buffered chunk has landed in the primitive's `chunks` store.
    const flush = (): Promise<void> =>
        new Promise((resolve) => {
            setTimeout(resolve, 0);
        });

    return { client: fake, flush, mutationSpy, push, pushStream, streamCalls, subscribeCalls, unsubscribeSpy };
};

export type { FakeClient };
export { createFakeClient };
