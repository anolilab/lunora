import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CirrusClient } from "../src/cirrus-client.js";
import { createStream, DEFAULT_MAX_BUFFER } from "../src/stream.js";
import type { FunctionReference } from "../src/types.js";

// --- Mock WebSocket ---------------------------------------------------------

interface MockSocket {
    addEventListener: (type: string, listener: (event?: unknown) => void) => void;
    close: () => void;
    onclose?: ((event?: unknown) => void) | null;
    onerror?: ((event?: unknown) => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onopen?: ((event?: unknown) => void) | null;
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    send: (data: string) => void;
    sent: string[];
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this as unknown as MockSocket);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }
    }

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket has been created yet");
    }

    return last;
};

const fn = <T = unknown>(reference: string): FunctionReference<"stream", Record<string, never>, T> =>
    ({ __cirrusRef: reference }) as FunctionReference<"stream", Record<string, never>, T>;

describe("stream", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- createStream unit tests ------------------------------------------------

    describe("createStream", () => {
        test("delivers pushed values to consumers in order", async () => {
            expect.assertions(3);

            const { handle, iterable } = createStream<number>({ onCancel: () => {} });

            for (const value of [1, 2]) {
                handle.push(value);
            }

            const iter = iterable[Symbol.asyncIterator]();

            await expect(iter.next()).resolves.toEqual({ done: false, value: 1 });
            await expect(iter.next()).resolves.toEqual({ done: false, value: 2 });

            handle.complete();

            await expect(iter.next()).resolves.toEqual({ done: true, value: undefined });
        });

        test("pending consumer resolves when a value is pushed later", async () => {
            expect.assertions(1);

            const { handle, iterable } = createStream<string>({ onCancel: () => {} });
            const iter = iterable[Symbol.asyncIterator]();

            const promise = iter.next();

            // Resolve the pending next() with a delayed push.
            queueMicrotask(() => {
                handle.push("delivered");
            });

            await expect(promise).resolves.toEqual({ done: false, value: "delivered" });
        });

        test("error surfaces as a rejection on the next pull", async () => {
            expect.assertions(1);

            const { handle, iterable } = createStream<number>({ onCancel: () => {} });

            handle.fail(new Error("boom"));

            const iter = iterable[Symbol.asyncIterator]();

            await expect(iter.next()).rejects.toThrow("boom");
        });

        test("cancel() invokes onCancel exactly once and closes the iterator", async () => {
            expect.assertions(2);

            const onCancel = vi.fn<() => void>();
            const { iterable } = createStream<number>({ onCancel });

            iterable.cancel();
            iterable.cancel(); // idempotent

            expect(onCancel).toHaveBeenCalledTimes(1);

            const iter = iterable[Symbol.asyncIterator]();

            await expect(iter.next()).resolves.toEqual({ done: true, value: undefined });
        });

        test("backpressure overflow surfaces a STREAM_BACKPRESSURE error", async () => {
            expect.assertions(1);

            const { handle, iterable } = createStream<number>({ maxBuffer: 2, onCancel: () => {} });

            for (const value of [1, 2, 3]) {
                handle.push(value); // third triggers fail
            }

            const iter = iterable[Symbol.asyncIterator]();

            // The first two queued items get cleared on fail; consumer sees the error.
            await expect(iter.next()).rejects.toMatchObject({ code: "STREAM_BACKPRESSURE" });
        });

        test("default buffer is at least 64 chunks", () => {
            expect.assertions(1);

            expect(DEFAULT_MAX_BUFFER).toBeGreaterThanOrEqual(64);
        });

        test("delivers `undefined` chunks without dropping them", async () => {
            expect.assertions(4);

            const { handle, iterable } = createStream<undefined | { ok: boolean }>({ onCancel: () => {} });
            const iter = iterable[Symbol.asyncIterator]();

            // Pending-then-push path: schedule the next() first, then enqueue
            // undefined via the flushOne path.
            const pendingNext = iter.next();

            queueMicrotask(() => {
                handle.push(undefined);
            });

            await expect(pendingNext).resolves.toEqual({ done: false, value: undefined });

            // Buffer-then-shift path: enqueue undefined first, then read it.
            handle.push(undefined);

            await expect(iter.next()).resolves.toEqual({ done: false, value: undefined });

            // Real value after undefined still flows.
            handle.push({ ok: true });

            await expect(iter.next()).resolves.toEqual({ done: false, value: { ok: true } });

            handle.complete();

            await expect(iter.next()).resolves.toEqual({ done: true, value: undefined });
        });
    });

    // --- CirrusClient.stream() integration tests --------------------------------

    describe("cirrusClient.stream()", () => {
        test("opens a WS, sends a stream frame, and yields chunks until complete", async () => {
            expect.assertions(3);

            const client = new CirrusClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

            const iterable = client.stream(fn<{ tick: number }>("metrics:tick"), {});

            // Drive the socket to "open" so the stream frame flushes.
            latestSocket().open();

            const sent = latestSocket().sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
            const streamFrame = sent.find((f) => f.type === "stream");

            expect(streamFrame).toBeDefined();
            expect(streamFrame).toMatchObject({
                type: "stream",
                query: { functionPath: "metrics:tick", args: {} },
            });

            const id = streamFrame?.id as string;

            // Server sends chunks.
            latestSocket().receive({ type: "chunk", id, data: { tick: 1 } });
            latestSocket().receive({ type: "chunk", id, data: { tick: 2 } });
            latestSocket().receive({ type: "complete", id });

            const collected: { tick: number }[] = [];

            for await (const chunk of iterable) {
                collected.push(chunk);
            }

            expect(collected).toEqual([{ tick: 1 }, { tick: 2 }]);

            client.close();
        });

        test("cancel() sends an unsubscribe frame and resolves the iterator", async () => {
            expect.assertions(2);

            const client = new CirrusClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

            const iterable = client.stream(fn<number>("metrics:loop"), {});

            latestSocket().open();
            const sent = latestSocket().sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
            const id = sent.find((f) => f.type === "stream")?.id as string;

            // Push a value, then cancel before consuming all.
            latestSocket().receive({ type: "chunk", id, data: 1 });

            iterable.cancel();

            const cancelFrame = latestSocket()
                .sent
.map((raw) => JSON.parse(raw) as Record<string, unknown>)
                .find((f) => f.type === "unsubscribe" && f.id === id);

            expect(cancelFrame).toBeDefined();

            // The iterator resolves to done after cancel.
            const collected: number[] = [];

            for await (const chunk of iterable) {
                collected.push(chunk);
            }

            // Either we read the buffered chunk before cancel cleared it, or we saw nothing — both are valid termination states.
            expect(collected.length).toBeLessThanOrEqual(1);

            client.close();
        });

        test("server-side error surfaces as a rejection on the consumer", async () => {
            expect.assertions(1);

            const client = new CirrusClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

            const iterable = client.stream(fn<number>("metrics:boom"), {});

            latestSocket().open();
            const id = (JSON.parse(latestSocket().sent[0] as string) as Record<string, unknown>).id as string;

            latestSocket().receive({ type: "error", id, error: { code: "FORBIDDEN", message: "nope" } });

            const consumer = (async () => {
                for await (const _chunk of iterable) {
                    /* unreachable */
                }
            })();

            await expect(consumer).rejects.toMatchObject({ message: "nope", code: "FORBIDDEN" });

            client.close();
        });

        test("client.close() fails any in-flight streams", async () => {
            expect.assertions(1);

            const client = new CirrusClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

            const iterable = client.stream(fn<number>("metrics:keepalive"), {});

            latestSocket().open();

            client.close();

            const consumer = (async () => {
                for await (const _chunk of iterable) {
                    /* unreachable */
                }
            })();

            await expect(consumer).rejects.toMatchObject({ code: "CLIENT_CLOSED" });
        });

        test("buffers the start frame while the socket is connecting and flushes it on open", async () => {
            expect.assertions(2);

            const client = new CirrusClient({ url: "https://app.example", WebSocket: createMockWebSocket() });
            const iterable = client.stream(fn<number>("metrics:tick"), {});

            // Before open: nothing has gone over the wire yet.
            expect(latestSocket().sent).toHaveLength(0);

            latestSocket().open();

            const flushed = latestSocket().sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

            expect(flushed.some((f) => f.type === "stream")).toBe(true);

            // Cleanly tear down so the iterator doesn't hang the test process.
            iterable.cancel();
            client.close();
        });
    });
});
