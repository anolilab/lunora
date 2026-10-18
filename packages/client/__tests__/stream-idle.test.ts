import { afterEach, describe, expect, it, vi } from "vitest";

import { httpStream } from "../src/http-stream";
import { connectLiveStream } from "../src/live-stream";
import type { HttpStreamRef } from "../src/types";

const encoder = new TextEncoder();

/** A response whose body the test feeds by hand. */
const openResponse = (headers: Record<string, string> = {}): { end: () => void; push: (text: string) => void; response: Response } => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start: (c) => {
            controller = c;
        },
    });

    return {
        end: () => {
            controller.close();
        },
        push: (text) => {
            controller.enqueue(encoder.encode(text));
        },
        response: new Response(body, { headers }),
    };
};

describe("live stream idle watchdog", () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it("reconnects when the connection goes quiet past the idle bound", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => openResponse({ "x-lunora-live-connection": "c" }).response);
        const live = connectLiveStream("/live/posts/connect", { fetch: fetchImpl, idleTimeoutMs: 1000, retryDelay: 100 });

        await vi.advanceTimersByTimeAsync(500);

        expect(fetchImpl).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(2000);

        expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);

        live.close();
    });

    it("stays connected while keepalive comments keep arriving", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const stream = openResponse({ "x-lunora-live-connection": "c" });
        const fetchImpl = vi.fn<typeof fetch>(async () => stream.response);
        const live = connectLiveStream("/live/posts/connect", { fetch: fetchImpl, idleTimeoutMs: 1000, retryDelay: 100 });

        for (let tick = 0; tick < 8; tick += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential ticks of fake time
            await vi.advanceTimersByTimeAsync(500);
            stream.push(":ka\n\n");
        }

        expect(fetchImpl).toHaveBeenCalledTimes(1);

        live.close();
    });

    it("keeps backing off when the server accepts the connection and drops it at once", async () => {
        expect.assertions(1);

        vi.useFakeTimers();
        vi.spyOn(Math, "random").mockReturnValue(1);

        const fetchImpl = vi.fn<typeof fetch>(async () => {
            const stream = openResponse({ "x-lunora-live-connection": "c" });

            stream.end();

            return stream.response;
        });
        const live = connectLiveStream("/live/posts/connect", { fetch: fetchImpl, idleTimeoutMs: 0, retryDelay: 1000 });

        await vi.advanceTimersByTimeAsync(5000);

        // 1s, 2s, 4s between attempts: attempts at 0s, 1s and 3s. A backoff reset on every 2xx would retry each second.
        expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4);

        live.close();
    });
});

describe("http stream idle watchdog", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    const route = { method: "GET", path: "/tokens" } as unknown as HttpStreamRef;

    it("reconnects a quiet stream when asked to bound idleness", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => openResponse().response);
        const stream = httpStream(route, undefined, { fetch: fetchImpl, idleTimeoutMs: 1000, reconnect: true });
        const iterator = stream[Symbol.asyncIterator]();

        iterator.next().catch(() => undefined);

        await vi.advanceTimersByTimeAsync(5000);

        expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);

        stream.cancel();
    });

    it("fails a quiet stream that did not ask to reconnect", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => openResponse().response);
        const stream = httpStream(route, undefined, { fetch: fetchImpl, idleTimeoutMs: 1000 });
        const outcome = stream[Symbol.asyncIterator]()
            .next()
            .then(
                () => "value",
                (error: unknown) => (error as { code?: string }).code,
            );

        await vi.advanceTimersByTimeAsync(1500);

        await expect(outcome).resolves.toBe("STREAM_IDLE");
    });

    it("leaves a quiet stream alone by default", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const fetchImpl = vi.fn<typeof fetch>(async () => openResponse().response);
        const stream = httpStream(route, undefined, { fetch: fetchImpl, reconnect: true });

        stream[Symbol.asyncIterator]()
            .next()
            .catch(() => undefined);

        await vi.advanceTimersByTimeAsync(600_000);

        expect(fetchImpl).toHaveBeenCalledTimes(1);

        stream.cancel();
    });
});
