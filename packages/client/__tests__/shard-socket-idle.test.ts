import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import type { FunctionReference } from "../src/types";

/**
 * A non-default shard's socket exists only to carry that shard's traffic, so it
 * is closed once nothing uses it — otherwise a UI that re-points a subscription
 * across shards (one per channel) keeps a socket open for every shard it ever
 * visited.
 */

interface MockSocket {
    close: () => void;
    frames: { id?: string; type: string }[];
    open: () => void;
    readyState: number;
    url: string;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public frames: { id?: string; type: string }[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public send(data: string): void {
            if (this.readyState !== 1) {
                throw new Error("socket is not open");
            }

            if (data !== "lunora-ping") {
                this.frames.push(JSON.parse(data) as { id?: string; type: string });
            }
        }

        public close(): void {
            if (this.readyState === 3) {
                return;
            }

            this.readyState = 3;
            this.dispatch("close", { code: 1006 });
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const list: FunctionReference = { __lunoraRef: "messages:list" };

const shardOf = (socket: MockSocket): string | null => new URL(socket.url).searchParams.get("shard");

const socketsFor = (shard: string): MockSocket[] => sockets.filter((socket) => shardOf(socket) === shard);

/** Sockets not yet closed, by shard (`null` = the default shard). */
const liveShards = (): (string | null)[] => sockets.filter((socket) => socket.readyState !== 3).map((socket) => shardOf(socket));

/** Subscribe on `shardKey` and open its socket. */
const subscribeOn = (client: LunoraClient, shardKey: string): (() => void) => {
    const unsubscribe = client.subscribe(list, { channelId: shardKey }, () => undefined, { shardKey });

    for (const socket of socketsFor(shardKey)) {
        if (socket.readyState === 0) {
            socket.open();
        }
    }

    return unsubscribe;
};

describe("idle shard sockets", () => {
    let client: LunoraClient;

    beforeEach(() => {
        vi.useFakeTimers();
        client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });
    });

    afterEach(() => {
        client.close();
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("closes each visited shard's socket once its last subscription goes, without reconnecting it", () => {
        expect.assertions(2);

        for (const channel of ["c1", "c2", "c3", "c4", "c5"]) {
            subscribeOn(client, channel)();
        }

        vi.advanceTimersByTime(60_000);

        expect(liveShards()).toStrictEqual([]);
        // Closed on purpose: no reconnect attempt opened a replacement.
        expect(sockets).toHaveLength(5);
    });

    it("keeps a shard's socket through a quick leave-and-return", () => {
        expect.assertions(2);

        subscribeOn(client, "a")();
        subscribeOn(client, "b");
        vi.advanceTimersByTime(100);
        subscribeOn(client, "a");
        vi.advanceTimersByTime(60_000);

        expect(socketsFor("a")).toHaveLength(1);
        expect(new Set(liveShards())).toStrictEqual(new Set(["a", "b"]));
    });

    it("keeps a shard open while a whisper topic or a connection context still uses it", () => {
        expect.assertions(2);

        const leaveTopic = client.whisperSubscribe("typing", () => undefined, { shardKey: "w" });
        const releaseContext = client.acquireConnectionContext({ roomId: "r" }, { shardKey: "p" });

        subscribeOn(client, "w")();
        subscribeOn(client, "p")();
        vi.advanceTimersByTime(60_000);

        expect(new Set(liveShards())).toStrictEqual(new Set(["p", "w"]));

        leaveTopic();
        releaseContext();
        vi.advanceTimersByTime(60_000);

        expect(liveShards()).toStrictEqual([]);
    });

    it("keeps a shard open while a write is queued for it", async () => {
        expect.assertions(2);

        const unsubscribe = subscribeOn(client, "q");

        // The socket drops after it was live, so a write to the shard queues for the reconnect.
        socketsFor("q")[0]?.close();

        const queued = client.mutation({ __lunoraRef: "messages:send" }, { text: "hi" }, { shardKey: "q" }).catch(() => undefined);

        await vi.advanceTimersByTimeAsync(0);

        expect(client.pendingCount()).toBe(1);

        unsubscribe();
        await vi.advanceTimersByTimeAsync(60_000);

        // Still held: the shard keeps reconnecting so the write can flush.
        const attempts = socketsFor("q").length;

        await vi.advanceTimersByTimeAsync(120_000);

        expect(socketsFor("q").length).toBeGreaterThan(attempts);

        client.close();
        await queued;
    });

    it("never closes the default shard's socket", () => {
        expect.assertions(1);

        const unsubscribe = client.subscribe(list, {}, () => undefined);

        sockets[0]?.open();
        unsubscribe();
        vi.advanceTimersByTime(60_000);

        expect(liveShards()).toStrictEqual([null]);
    });
});

/** An HTTP stub: every RPC answers `ok`, or fails like a dropped network. */
const makeFetch = (online: boolean) =>
    vi.fn<typeof fetch>(async () => {
        if (!online) {
            throw new TypeError("Failed to fetch");
        }

        return Response.json({ result: "ok" });
    });

const send: FunctionReference = { __lunoraRef: "messages:send" };
const generate = { __lunoraRef: "messages:generate" } as FunctionReference<"stream">;

/** Visit `shardKey` (subscribe, connect), leave, and let the idle close run. */
const visitAndIdleOut = (client: LunoraClient, shardKey: string): void => {
    subscribeOn(client, shardKey)();
    vi.advanceTimersByTime(60_000);
};

describe("idle shard sockets and writes", () => {
    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    for (const queueBeforeFirstConnect of [false, true]) {
        it(`sends an online write to an idled-out shard over HTTP (queueBeforeFirstConnect: ${String(queueBeforeFirstConnect)})`, async () => {
            vi.useFakeTimers();

            const fetchMock = makeFetch(true);
            const client = new LunoraClient({
                fetch: fetchMock,
                offlineQueue: { queueBeforeFirstConnect },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            visitAndIdleOut(client, "a");

            expect(liveShards()).toStrictEqual([]);

            const write = client.mutation(send, { text: "hi" }, { shardKey: "a" });

            await vi.advanceTimersByTimeAsync(1000);

            await expect(write).resolves.toBe("ok");
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(client.pendingCount()).toBe(0);

            client.close();
        });

        it(`still queues an offline write to an idled-out shard (queueBeforeFirstConnect: ${String(queueBeforeFirstConnect)})`, async () => {
            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: makeFetch(false),
                offlineQueue: { queueBeforeFirstConnect },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            visitAndIdleOut(client, "a");

            // Visiting the shard made it queue-eligible; closing its idle socket must not undo that.
            expect(client.canQueueOffline("a")).toBe(true);

            const write = client.mutation(send, { text: "offline" }, { shardKey: "a" }).catch((error: unknown) => error);

            await vi.advanceTimersByTimeAsync(0);

            expect(client.pendingCount()).toBe(1);

            client.close();
            await write;
        });
    }

    it("opens the shard's socket to flush a write queued for a shard with no socket", async () => {
        vi.useFakeTimers();

        const fetchMock = makeFetch(true);
        const client = new LunoraClient({
            fetch: fetchMock,
            offlineQueue: { queueBeforeFirstConnect: true },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        // Never subscribed: the write queues before a first connect, and something must connect it.
        const write = client.mutation(send, { text: "first" }, { shardKey: "n" });

        await vi.advanceTimersByTimeAsync(0);

        expect(client.pendingCount()).toBe(1);
        expect(socketsFor("n")).toHaveLength(1);

        socketsFor("n")[0]?.open();
        await vi.advanceTimersByTimeAsync(1000);

        await expect(write).resolves.toBe("ok");
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("delivers a durable stream's cancel queued while the socket was down, even after the shard idles", async () => {
        vi.useFakeTimers();

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });
        const unsubscribe = subscribeOn(client, "d");
        const stream = client.stream(generate, {}, { durable: true, shardKey: "d" });
        const started = socketsFor("d")[0]?.frames.find((frame) => frame.type === "stream");

        expect(started).toBeDefined();

        socketsFor("d")[0]?.close();
        await stream[Symbol.asyncIterator]().return?.();
        unsubscribe();

        // Down for longer than the idle window, then the network returns.
        await vi.advanceTimersByTimeAsync(8000);

        for (let tick = 0; tick < 200; tick += 1) {
            // eslint-disable-next-line no-await-in-loop -- each reconnect attempt must run before the next socket is opened
            await vi.advanceTimersByTimeAsync(250);

            for (const socket of socketsFor("d")) {
                if (socket.readyState === 0) {
                    socket.open();
                }
            }
        }

        const cancels = socketsFor("d")
            .flatMap((socket) => socket.frames)
            .filter((frame) => frame.type === "unsubscribe" && frame.id === started?.id);

        expect(cancels).toHaveLength(1);

        client.close();
    });

    it("stops reconnecting a shard left while its socket was down", async () => {
        vi.useFakeTimers();

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });
        const unsubscribe = subscribeOn(client, "b");

        socketsFor("b")[0]?.close();
        // The unsubscribe queues for a reconnect, but needs none: the server dropped it with the socket.
        unsubscribe();
        await vi.advanceTimersByTimeAsync(10_000);

        const attempts = socketsFor("b").length;

        await vi.advanceTimersByTimeAsync(300_000);

        expect(socketsFor("b")).toHaveLength(attempts);
        expect(liveShards()).toStrictEqual([]);

        client.close();
    });

    it("closes a shard that only a stream or a whisper opened, once unused", async () => {
        vi.useFakeTimers();

        const client = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });
        const stream = client.stream(generate, {}, { shardKey: "s" });

        client.whisper("typing", { x: 1 }, { shardKey: "w" });

        for (const socket of sockets) {
            socket.open();
        }

        await stream[Symbol.asyncIterator]().return?.();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(liveShards()).toStrictEqual([]);
        expect(sockets).toHaveLength(2);

        client.close();
    });
});
