import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import { connectLiveStream } from "../src/live-stream";

/**
 * A controllable SSE response. `send` writes one raw SSE block; `end` closes the
 * stream so the transport schedules a reconnect.
 */
class FakeStream {
    public readonly response: Response;

    private controller!: ReadableStreamDefaultController<Uint8Array>;

    public constructor(connectionId: string) {
        const stream = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.controller = controller;
            },
        });

        this.response = new Response(stream, { headers: { "x-lunora-live-connection": connectionId } });
    }

    public end(): void {
        this.controller.close();
    }

    public send(text: string): void {
        this.controller.enqueue(new TextEncoder().encode(text));
    }
}

interface ControlCall {
    action?: string;
    connectionId?: string;
    shardKey?: string;
    subscriptionId?: string;
    topic?: string;
}

const setup = () => {
    const streams: FakeStream[] = [];
    const controls: ControlCall[] = [];

    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        let url: string;

        if (typeof input === "string") {
            url = input;
        } else if (input instanceof URL) {
            url = input.href;
        } else {
            url = input.url;
        }

        if (/\/connect(?:\?|$)/u.test(url)) {
            const stream = new FakeStream(`c${String(streams.length + 1)}`);

            streams.push(stream);

            return Promise.resolve(stream.response);
        }

        const body = init?.body;

        controls.push((typeof body === "string" ? JSON.parse(body) : {}) as ControlCall);

        return Promise.resolve(Response.json({ ok: true }));
    };

    return { controls, fetchImpl, streams };
};

const liveFrame = (topic: string, payload: unknown): string => `event: live\ndata: ${JSON.stringify({ data: encodeWire(payload), topic })}\n\n`;

const flush = async (turns = 6): Promise<void> => {
    for (let index = 0; index < turns; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- drain queued microtasks so the pump advances
        await Promise.resolve();
    }
};

describe("connectLiveStream", () => {
    it("subscribes, delivers events, and unsubscribes over one connection", async () => {
        expect.assertions(5);

        const { controls, fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        expect(live.connectionId).toBe("c1");

        const received: unknown[] = [];
        const off = live.subscribe({ id: "s1", onEvent: (payload) => received.push(payload), topic: "feed" });

        await flush();

        // The subscribe went to the control endpoint, scoped to this connection.
        expect(controls).toEqual([{ action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" }]);

        streams[0]?.send(liveFrame("feed", { event: "new_post" }));

        await flush();

        expect(received).toEqual([{ event: "new_post" }]);

        off();

        await flush();

        expect(controls.at(-1)).toEqual({ action: "unsubscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" });

        // No delivery after the unsubscribe.
        streams[0]?.send(liveFrame("feed", { event: "after" }));

        await flush();

        expect(received).toEqual([{ event: "new_post" }]);

        live.close();
    });

    it("keeps the SSE control body to the connection and subscription, with no stream or shard key", async () => {
        expect.assertions(2);

        const { controls, fetchImpl } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        live.subscribe({ id: "s1", onEvent: () => undefined, topic: "feed" });

        await flush();

        // The WebSocket grant fields (`stream`, `shardKey`) must not leak into the SSE control call.
        expect(Object.keys(controls[0] ?? {})).toStrictEqual(["action", "connectionId", "subscriptionId", "topic"]);
        expect(controls[0]).toStrictEqual({ action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" });

        live.close();
    });

    it("reconnects and re-registers active subscriptions on the new connection", async () => {
        expect.assertions(2);

        const { controls, fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl, maxDelayMs: 5, retryDelay: 5 });

        await live.ready;

        live.subscribe({ id: "s1", topic: "feed" });

        await flush();

        // Drop the stream; the transport must reconnect and resubscribe.
        streams[0]?.end();

        await new Promise((resolve) => {
            setTimeout(resolve, 40);
        });
        await flush();

        expect(live.connectionId).toBe("c2");
        expect(controls.filter((call) => call.action === "subscribe")).toEqual([
            { action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" },
            { action: "subscribe", connectionId: "c2", subscriptionId: "s1", topic: "feed" },
        ]);

        live.close();
    });

    it("does not abort a fresh connection when a subscribe sent before it connects returns 404", async () => {
        expect.assertions(3);

        const { fetchImpl } = setup();
        const signals: (AbortSignal | null | undefined)[] = [];
        // Holds the first subscribe, sent before any connection exists, until the test releases it.
        const held: { release?: (response: Response) => void } = {};

        const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);

            if (/\/connect(?:\?|$)/u.test(url)) {
                signals.push(init?.signal);
            }

            const body = typeof init?.body === "string" ? (JSON.parse(init.body) as ControlCall) : undefined;

            if (body?.action === "subscribe" && body.connectionId === undefined && held.release === undefined) {
                return new Promise<Response>((resolve) => {
                    held.release = resolve;
                });
            }

            return fetchImpl(input, init);
        };

        const live = connectLiveStream("https://x/live/posts/connect", { fetch, maxDelayMs: 5, retryDelay: 5 });

        live.subscribe({ id: "s1", topic: "feed" });

        await flush();

        // The connection is up, and the resubscribe waits behind the held reply.
        expect(live.connectionId).toBe("c1");
        expect(held.release).toBeDefined();

        held.release?.(new Response(null, { status: 404 }));

        await flush(20);

        expect(signals[0]?.aborted).toBe(false);

        live.close();
    });

    it("sends the shard named on the connect url with every control call", async () => {
        expect.assertions(2);

        const { controls, fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect?shard=tenant-7", { fetch: fetchImpl });

        await live.ready;

        live.subscribe({ id: "s1", topic: "feed" });

        await flush();

        // Without the shard the control call would miss the connection on another DO.
        expect(controls).toEqual([{ action: "subscribe", connectionId: "c1", shardKey: "tenant-7", subscriptionId: "s1", topic: "feed" }]);
        expect(streams).toHaveLength(1);

        live.close();
    });

    it("refuses to re-use an active subscription id for a different topic", async () => {
        expect.assertions(2);

        const { fetchImpl } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        live.subscribe({ id: "s1", topic: "feed" });

        expect(() => live.subscribe({ id: "s1", topic: "other" })).toThrow(/already follows "feed"/u);

        // The same id for the same topic is a re-subscribe, not a conflict.
        expect(() => live.subscribe({ id: "s1", topic: "feed" })).not.toThrow();

        live.close();
    });

    it("rejects a url that is not a connect route", () => {
        expect.assertions(1);

        expect(() => connectLiveStream("https://x/live/posts")).toThrow(/connect URL/u);
    });

    it("derives the control url from the connect path, keeping the query string as written", async () => {
        expect.assertions(2);

        const { fetchImpl } = setup();
        const urls: string[] = [];
        const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            if (typeof input === "string") {
                urls.push(input);
            } else {
                urls.push(input instanceof URL ? input.href : input.url);
            }

            return fetchImpl(input, init);
        };

        const live = connectLiveStream("https://x/app/connect/connect?note=/connect&shard=t", { fetch });

        await live.ready;

        live.subscribe({ id: "s1", topic: "feed" });

        await flush();

        // Only the final path segment is swapped; a `/connect` inside the query is left alone.
        expect(urls.at(-1)).toBe("https://x/app/connect/control?note=/connect&shard=t");
        expect(live.connectionId).toBe("c1");

        live.close();
    });

    it("routes a multiplexed frame to every subscription on its topic", async () => {
        expect.assertions(2);

        const { fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        const first: unknown[] = [];
        const second: unknown[] = [];

        live.subscribe({ id: "a", onEvent: (payload) => first.push(payload), topic: "t" });
        live.subscribe({ id: "b", onEvent: (payload) => second.push(payload), topic: "t" });

        await flush();

        // A frame on another topic reaches neither.
        streams[0]?.send(liveFrame("other", 1));
        streams[0]?.send(liveFrame("t", 2));

        await flush();

        expect(first).toEqual([2]);
        expect(second).toEqual([2]);

        live.close();
    });

    it("notifies onEvent observers of every event", async () => {
        expect.assertions(1);

        const { fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });
        const seen: { payload: unknown; topic: string }[] = [];

        live.onEvent((event) => seen.push({ payload: event.payload, topic: event.topic }));

        await live.ready;

        streams[0]?.send(liveFrame("feed", "hello"));

        await flush();

        expect(seen).toEqual([{ payload: "hello", topic: "feed" }]);

        live.close();
    });

    it("delivers events framed with CRLF line endings", async () => {
        expect.assertions(1);

        const { fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        const received: unknown[] = [];

        live.subscribe({ id: "s1", onEvent: (payload) => received.push(payload), topic: "feed" });

        await flush();

        streams[0]?.send(liveFrame("feed", "crlf").replaceAll("\n", "\r\n"));

        await flush();

        expect(received).toEqual(["crlf"]);

        live.close();
    });

    it("rejects ready when closed before the first connection", async () => {
        expect.assertions(1);

        const live = connectLiveStream("https://x/live/posts/connect", {
            fetch: () =>
                new Promise<Response>(() => {
                    /* never settles: the stream is closed before it connects */
                }),
        });

        live.close();

        await expect(live.ready).rejects.toThrow("closed before the first connection");
    });

    it("keeps the first handler when an active id is re-subscribed to the same topic", async () => {
        expect.assertions(5);

        const { controls, fetchImpl, streams } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        const first: unknown[] = [];
        const second: unknown[] = [];
        const offFirst = live.subscribe({ id: "s1", onEvent: (payload) => first.push(payload), topic: "feed" });
        const offSecond = live.subscribe({ id: "s1", onEvent: (payload) => second.push(payload), topic: "feed" });

        await flush();

        // One shard-side subscription serves both handlers.
        expect(controls).toEqual([{ action: "subscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" }]);

        streams[0]?.send(liveFrame("feed", { event: "one" }));

        await flush();

        expect(first).toEqual([{ event: "one" }]);
        expect(second).toEqual([{ event: "one" }]);

        // Releasing the first handle leaves the registration and the second handler in place.
        offFirst();
        offFirst();

        streams[0]?.send(liveFrame("feed", { event: "two" }));

        await flush();

        expect(second).toEqual([{ event: "one" }, { event: "two" }]);

        offSecond();

        await flush();

        expect(controls.at(-1)).toEqual({ action: "unsubscribe", connectionId: "c1", subscriptionId: "s1", topic: "feed" });

        live.close();
    });

    it("refuses subscribe after close without registering or sending a control call", async () => {
        expect.assertions(2);

        const { controls, fetchImpl } = setup();
        const live = connectLiveStream("https://x/live/posts/connect", { fetch: fetchImpl });

        await live.ready;

        live.close();

        expect(() => live.subscribe({ id: "s1", topic: "feed" })).toThrow(/subscribe on a closed stream/u);

        await flush();

        expect(controls).toEqual([]);
    });
});
