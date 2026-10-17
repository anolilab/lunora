import { encodeWire } from "@lunora/wire";
import { describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * Live topic streams over the shard DO's SSE + control endpoints. A server
 * publish reaches only the subscribers admitted for its stream: SSE connections
 * subscribed through it, and WebSocket whisper members holding a grant for it.
 */

interface Frame {
    code?: string;
    data?: unknown;
    from?: string;
    topic?: string;
    type: string;
}

/** Round-trips the hibernation attachment and records sent frames. */
class FakeSocket {
    public readonly frames: Frame[] = [];

    private attachment: unknown;

    public constructor(initial?: unknown) {
        this.attachment = initial;
    }

    public deserializeAttachment(): unknown {
        return this.attachment;
    }

    public send(data: string): void {
        this.frames.push(JSON.parse(data) as Frame);
    }

    public serializeAttachment(value: unknown): void {
        this.attachment = value;
    }
}

/** A socket whose attachment write can be made to fail, as the runtime does past 16 KiB. */
class AttachmentFullSocket extends FakeSocket {
    public refuseWrites = false;

    public override serializeAttachment(value: unknown): void {
        if (this.refuseWrites) {
            throw new Error("A WebSocket 'attachment' cannot be larger than 16384 bytes.");
        }

        super.serializeAttachment(value);
    }
}

class LiveShard extends ShardDO {
    public sockets: FakeSocket[] = [];

    // eslint-disable-next-line class-methods-use-this -- abstract stub; the live path never dispatches an RPC
    public override handleRpc(): Promise<unknown> {
        return Promise.resolve({});
    }

    /** What a scheduled job's or queue consumer's `ctx.live.publish` calls on the shard it runs in. */
    public publishFromAction(topic: string, payload: unknown, options: { shardKey?: string; stream: string }): Promise<number> {
        return this.publishLiveFromAction(topic, payload, options);
    }
}

const makeShard = (sockets: FakeSocket[]): LiveShard => {
    const state = {
        acceptWebSocket() {},
        getWebSockets: () => sockets,
        storage: { sql: {} },
    } as unknown as ShardDOState;

    return new LiveShard(state, {});
};

interface SseBlock {
    data: unknown;
    event: string;
}

/** Parse one SSE block. Empty blocks return `undefined` (skip); comments get `event: "comment"`. */
const parseBlock = (block: string): SseBlock | undefined => {
    if (block.trim() === "") {
        return undefined;
    }

    if (block.startsWith(":")) {
        return { data: undefined, event: "comment" };
    }

    let event = "message";
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) {
            event = line.slice("event: ".length);
        } else if (line.startsWith("data: ")) {
            dataLines.push(line.slice("data: ".length));
        }
    }

    return { data: dataLines.length > 0 ? JSON.parse(dataLines.join("\n")) : undefined, event };
};

/** Reads complete SSE blocks (separated by `\n\n`) off a live response body. */
class SseReader {
    private buffer = "";

    private readonly decoder = new TextDecoder();

    private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

    public constructor(response: Response) {
        const { body } = response;

        if (body === null) {
            throw new Error("live response had no body");
        }

        this.reader = body.getReader();
    }

    /**
     * Read the next SSE block. Comment blocks (`:…`) come back with
     * `event: "comment"`; a closed stream returns `event: "eof"`.
     */
    public async next(): Promise<SseBlock> {
        for (;;) {
            const separator = this.buffer.indexOf("\n\n");

            if (separator === -1) {
                // eslint-disable-next-line no-await-in-loop -- sequential read off one stream
                const { done, value } = await this.reader.read();

                if (done) {
                    return { data: undefined, event: "eof" };
                }

                this.buffer += this.decoder.decode(value, { stream: true });

                continue;
            }

            const block = this.buffer.slice(0, separator);

            this.buffer = this.buffer.slice(separator + 2);

            const parsed = parseBlock(block);

            if (parsed !== undefined) {
                return parsed;
            }
        }
    }
}

const connect = async (shard: LiveShard): Promise<{ connectionId: string; response: Response }> => {
    const response = await shard.fetch(new Request("https://x/_lunora/live/connect", { method: "GET" }));
    const connectionId = response.headers.get("x-lunora-live-connection");

    if (connectionId === null) {
        throw new Error("no connection id header");
    }

    return { connectionId, response };
};

const control = async (shard: LiveShard, body: Record<string, unknown>): Promise<Response> =>
    shard.fetch(new Request("https://x/_lunora/live/control", { body: JSON.stringify(body), method: "POST" }));

const publish = async (shard: LiveShard, body: Record<string, unknown>): Promise<Response> =>
    shard.fetch(new Request("https://x/_lunora/live/publish", { body: JSON.stringify(body), method: "POST" }));

/** A control call as `userId`, the caller the worker stamps on it. */
const controlAs = async (shard: LiveShard, userId: string, body: Record<string, unknown>): Promise<Response> =>
    shard.fetch(new Request("https://x/_lunora/live/control", { body: JSON.stringify(body), headers: { "x-lunora-userid": userId }, method: "POST" }));

const joinWhisper = async (shard: LiveShard, socket: FakeSocket, topic: string): Promise<void> => {
    await shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ topic, type: "whisper_subscribe" }));
};

describe("shardDO live streams", () => {
    it("fans a publish out to two SSE subscribers of the topic", async () => {
        expect.assertions(4);

        const shard = makeShard([]);
        const a = await connect(shard);
        const b = await connect(shard);
        const readerA = new SseReader(a.response);
        const readerB = new SseReader(b.response);

        // Each connection opens with a comment frame that flushes its id header.
        const firstA = await readerA.next();
        const firstB = await readerB.next();

        expect(firstA.event).toBe("comment");
        expect(firstB.event).toBe("comment");

        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "s1", topic: "feed" });
        await control(shard, { action: "subscribe", stream: "s", connectionId: b.connectionId, subscriptionId: "s1", topic: "feed" });

        await publish(shard, { stream: "s", data: { event: "new_post" }, topic: "feed" });

        // Both subscribers receive the same frame, carrying the topic for routing.
        await expect(readerA.next()).resolves.toEqual({ data: { data: { event: "new_post" }, topic: "feed" }, event: "live" });
        await expect(readerB.next()).resolves.toEqual({ data: { data: { event: "new_post" }, topic: "feed" }, event: "live" });
    });

    it("does not deliver a stream publish to a WebSocket whisper member of the same bare topic", async () => {
        expect.assertions(2);

        const socket = new FakeSocket({ subs: {} });
        const shard = makeShard([socket]);

        await shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ topic: "feed", type: "whisper_subscribe" }));

        const sse = await connect(shard);
        const reader = new SseReader(sse.response);

        await reader.next();
        await control(shard, { action: "subscribe", stream: "s", connectionId: sse.connectionId, subscriptionId: "s1", topic: "feed" });
        await publish(shard, { stream: "s", data: { event: "new_post" }, topic: "feed" });

        // The SSE subscriber that passed the stream's onSubscribe gets the event; the bare-topic whisper member does not.
        await expect(reader.next()).resolves.toEqual({ data: { data: { event: "new_post" }, topic: "feed" }, event: "live" });
        expect(socket.frames).toEqual([]);
    });

    it("delivers a stream publish to a WebSocket whisper member admitted for that stream and topic", async () => {
        expect.assertions(2);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await joinWhisper(shard, socket, "feed");
        const granted = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });

        expect(granted.status).toBe(200);

        await publish(shard, { stream: "s", data: { event: "new_post" }, topic: "feed" });

        // The grant is the stream's own onSubscribe decision, so the member gets the event as a whisper on the topic.
        expect(socket.frames).toEqual([{ data: { event: "new_post" }, topic: "feed", type: "whisper" }]);
    });

    it("does not deliver a stream publish to a WebSocket member admitted only for another stream", async () => {
        expect.assertions(3);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await joinWhisper(shard, socket, "feed");
        const granted = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "other", subscriptionId: "s1", topic: "feed" });

        expect(granted.status).toBe(200);

        const response = await publish(shard, { stream: "s", data: "private", topic: "feed" });

        await expect(response.json()).resolves.toEqual({ delivered: 0 });
        expect(socket.frames).toEqual([]);
    });

    it("does not deliver to a WebSocket that holds a grant but never joined the topic as a whisper member", async () => {
        expect.assertions(2);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        const granted = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });

        expect(granted.status).toBe(200);

        await publish(shard, { stream: "s", data: "x", topic: "feed" });

        expect(socket.frames).toEqual([]);
    });

    it("refuses a WebSocket grant from a caller other than the socket's owner", async () => {
        expect.assertions(3);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await joinWhisper(shard, socket, "feed");
        // The owner's own grant proves the socket exists, so the intruder's 404 is an ownership refusal.
        const owner = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });
        const intruder = await controlAs(shard, "user-b", { action: "subscribe", connectionId: "ws-a", stream: "other", subscriptionId: "s2", topic: "feed" });

        expect(owner.status).toBe(200);
        expect(intruder.status).toBe(404);

        await publish(shard, { stream: "other", data: "x", topic: "feed" });

        expect(socket.frames).toEqual([]);
    });

    it("stops delivering to a WebSocket after its unsubscribe", async () => {
        expect.assertions(3);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await joinWhisper(shard, socket, "feed");
        const granted = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });
        const revoked = await controlAs(shard, "user-a", { action: "unsubscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });

        expect(granted.status).toBe(200);
        expect(revoked.status).toBe(200);

        await publish(shard, { stream: "s", data: "x", topic: "feed" });

        expect(socket.frames).toEqual([]);
    });

    it("refuses a grant the attachment cannot hold, and delivers nothing under it", async () => {
        expect.assertions(3);

        const socket = new AttachmentFullSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await joinWhisper(shard, socket, "feed");
        socket.refuseWrites = true;

        const refused = await controlAs(shard, "user-a", { action: "subscribe", connectionId: "ws-a", stream: "s", subscriptionId: "s1", topic: "feed" });

        // An acknowledged grant that never persisted would stop delivering silently after the next hibernation.
        expect(refused.status).toBe(429);

        const response = await publish(shard, { stream: "s", data: "x", topic: "feed" });

        await expect(response.json()).resolves.toEqual({ delivered: 0 });
        expect(socket.frames).toEqual([]);
    });

    it("caps the live topics one WebSocket may hold, refusing the next grant", async () => {
        expect.assertions(1);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);
        const statuses: number[] = [];

        // Eight is ShardDO.MAX_LIVE_TOPICS_PER_SOCKET: a grant lives in the 16 KiB attachment, so the cap is far below the SSE one.
        for (let index = 0; index < 9; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential grants keep the count deterministic
            const response = await controlAs(shard, "user-a", {
                action: "subscribe",
                connectionId: "ws-a",
                stream: "s",
                subscriptionId: `s${String(index)}`,
                topic: `t${String(index)}`,
            });

            statuses.push(response.status);
        }

        expect(statuses).toEqual([...Array.from({ length: 8 }).fill(200), 429]);
    });

    it("tells a WebSocket its connection id on connect, so the client can request a grant for it", async () => {
        expect.assertions(1);

        const socket = new FakeSocket({ connectionId: "ws-a", subs: {}, userId: "user-a" });
        const shard = makeShard([socket]);

        await shard.webSocketMessage(socket as unknown as WebSocket, JSON.stringify({ type: "connect" }));

        expect(socket.frames).toContainEqual({ connectionId: "ws-a", subject: "user-a", type: "identity" });
    });

    it("delivers a live publish to SSE readers without a relay hop that could fail it", async () => {
        expect.assertions(3);

        const shard = makeShard([]);
        const relayed: string[] = [];

        // A relay whose forward always rejects: a live publish must neither call it nor fail on it.
        Reflect.set(shard, "relay", {
            forwardWhisper: (topic: string) => {
                relayed.push(topic);

                return Promise.reject(new Error("relay down"));
            },
        });

        const sse = await connect(shard);
        const reader = new SseReader(sse.response);

        await reader.next();
        await control(shard, { action: "subscribe", stream: "s", connectionId: sse.connectionId, subscriptionId: "s1", topic: "feed" });

        const response = await publish(shard, { stream: "s", data: { event: "new_post" }, topic: "feed" });

        expect(response.status).toBe(200);
        await expect(reader.next()).resolves.toEqual({ data: { data: { event: "new_post" }, topic: "feed" }, event: "live" });
        expect(relayed).toEqual([]);
    });

    it("caps one client IP per shard so another IP can still connect", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const connectFrom = async (ip: string, userId: string): Promise<number> => {
            const response = await shard.fetch(
                new Request("https://x/_lunora/live/connect", {
                    headers: { "x-lunora-client-ip": ip, "x-lunora-userid": userId },
                    method: "GET",
                }),
            );

            return response.status;
        };

        // Distinct user ids from one IP: the per-user bucket never fills, so only the IP bucket can refuse.
        const statuses: number[] = [];

        for (let index = 0; index < 33; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential connects keep the count deterministic
            statuses.push(await connectFrom("203.0.113.1", `user-${String(index)}`));
        }

        expect(statuses).toEqual([...Array.from({ length: 32 }).fill(200), 503]);
        await expect(connectFrom("203.0.113.2", "user-other")).resolves.toBe(200);
    });

    it("buckets anonymous callers per client IP, not in one shared anonymous bucket", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const connectAnonymous = async (ip: string): Promise<number> => {
            const response = await shard.fetch(new Request("https://x/_lunora/live/connect", { headers: { "x-lunora-client-ip": ip }, method: "GET" }));

            return response.status;
        };

        // One anonymous client holds its full 32 idle connections.
        const held: number[] = [];

        for (let index = 0; index < 32; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential connects keep the count deterministic
            held.push(await connectAnonymous("203.0.113.1"));
        }

        expect(held).toEqual(Array.from({ length: 32 }).fill(200));
        // A second anonymous client, from another IP, is not locked out by the first.
        await expect(connectAnonymous("203.0.113.2")).resolves.toBe(200);
    });

    it("stops delivering to a connection after its unsubscribe", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const a = await connect(shard);
        const reader = new SseReader(a.response);

        await reader.next();

        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "s1", topic: "t" });
        await control(shard, { action: "unsubscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "s1", topic: "t" });

        // A publish on the unsubscribed topic must be skipped; the NEXT frame on the
        // stream is the one on the still-subscribed topic, proving the skip.
        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "s2", topic: "other" });
        await publish(shard, { stream: "s", data: "skipped", topic: "t" });
        await publish(shard, { stream: "s", data: "delivered", topic: "other" });

        await expect(reader.next()).resolves.toEqual({ data: { data: "delivered", topic: "other" }, event: "live" });
    });

    it("keys subscriptions by id so two subscriptions can share a topic", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const a = await connect(shard);
        const reader = new SseReader(a.response);

        await reader.next();

        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "one", topic: "t" });
        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "two", topic: "t" });
        // Removing one subscription must not evict the other.
        await control(shard, { action: "unsubscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "one", topic: "t" });

        await publish(shard, { stream: "s", data: 1, topic: "t" });

        await expect(reader.next()).resolves.toEqual({ data: { data: 1, topic: "t" }, event: "live" });
    });

    it("keeps a stream's subscribers apart: a publish on another stream reaches none of them", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const { connectionId, response } = await connect(shard);
        const reader = new SseReader(response);

        await reader.next();
        await control(shard, { action: "subscribe", connectionId, stream: "public", subscriptionId: "s1", topic: "feed" });

        // A private stream's publish on the same topic must not reach the public subscriber.
        const elsewhere = await publish(shard, { data: "private", stream: "private", topic: "feed" });

        await expect(elsewhere.json()).resolves.toEqual({ delivered: 0 });

        const own = await publish(shard, { data: "public", stream: "public", topic: "feed" });

        await expect(own.json()).resolves.toEqual({ delivered: 1 });
    });

    it("refuses a publish to a room topic, which members trust as their handler's output", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const room = await publish(shard, { data: "forged", stream: "s", topic: "room:chat" });

        expect(room.status).toBe(403);
    });

    it("refuses an oversized publish rather than dropping it silently", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const response = await publish(shard, { data: "x".repeat(8192), stream: "s", topic: "feed" });

        expect(response.status).toBe(413);
    });

    it("measures the publish cap in UTF-8 bytes, not UTF-16 units", async () => {
        expect.assertions(1);

        // 1500 three-byte characters: 1502 UTF-16 units under the cap, but over 4500 bytes.
        const shard = makeShard([]);
        const response = await publish(shard, { data: "€".repeat(1500), stream: "s", topic: "feed" });

        expect(response.status).toBe(413);
    });

    it("drops a live reader that stops draining once its queued bytes pass the bound", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        // The response is never read, so every frame queues on the stream.
        const { connectionId } = await connect(shard);

        await control(shard, { action: "subscribe", connectionId, stream: "s", subscriptionId: "s1", topic: "feed" });

        const delivered: number[] = [];

        for (let index = 0; index < 200; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- publishes are ordered; each reads its own count
            const response = await publish(shard, { data: "x".repeat(4000), stream: "s", topic: "feed" });

            // eslint-disable-next-line no-await-in-loop -- see above
            const body: { delivered: number } = await response.json();

            delivered.push(body.delivered);
        }

        expect(delivered[0]).toBe(1);
        expect(delivered.at(-1)).toBe(0);
    });

    it("refuses a control call naming a topic or subscription id over the length bound", async () => {
        expect.assertions(3);

        const shard = makeShard([]);
        const { connectionId } = await connect(shard);
        const longTopic = await control(shard, { action: "subscribe", connectionId, stream: "s", subscriptionId: "s1", topic: "t".repeat(257) });
        const longId = await control(shard, { action: "subscribe", connectionId, stream: "s", subscriptionId: "i".repeat(257), topic: "feed" });
        const atBound = await control(shard, { action: "subscribe", connectionId, stream: "s", subscriptionId: "s1", topic: "t".repeat(256) });

        expect(longTopic.status).toBe(400);
        expect(longId.status).toBe(400);
        expect(atBound.status).toBe(200);
    });

    it("refuses publish as a control action; publish has its own endpoint", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const { connectionId } = await connect(shard);
        const response = await control(shard, { action: "publish", connectionId, data: "x", stream: "s", subscriptionId: "s1", topic: "feed" });

        expect(response.status).toBe(400);
    });

    it("ignores a topics query string on connect: no subscription is granted before a subscribe", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const response = await shard.fetch(new Request("https://x/_lunora/live/connect?topics=alerts", { method: "GET" }));
        const reader = new SseReader(response);

        await reader.next();

        const alerts = await publish(shard, { data: "hello", stream: "s", topic: "alerts" });

        expect(alerts.status).toBe(200);
    });

    it("refuses a control call from a caller other than the connection's owner", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const owned = await shard.fetch(new Request("https://x/_lunora/live/connect", { headers: { "x-lunora-userid": "user-a" }, method: "GET" }));
        const connectionId = owned.headers.get("x-lunora-live-connection") ?? "";
        const intruder = await shard.fetch(
            new Request("https://x/_lunora/live/control", {
                body: JSON.stringify({ action: "subscribe", stream: "s", connectionId, subscriptionId: "s1", topic: "t" }),
                headers: { "x-lunora-userid": "user-b" },
                method: "POST",
            }),
        );
        const owner = await shard.fetch(
            new Request("https://x/_lunora/live/control", {
                body: JSON.stringify({ action: "subscribe", stream: "s", connectionId, subscriptionId: "s1", topic: "t" }),
                headers: { "x-lunora-userid": "user-a" },
                method: "POST",
            }),
        );

        expect(intruder.status).toBe(404);
        expect(owner.status).toBe(200);
    });

    it("rejects a control call naming an unknown connection", async () => {
        expect.assertions(1);

        const shard = makeShard([]);
        const response = await control(shard, { action: "subscribe", stream: "s", connectionId: "nope", subscriptionId: "s1", topic: "t" });

        expect(response.status).toBe(404);
    });

    it("delivers an in-shard action publish to the SSE subscribers of its stream, and returns the count", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const a = await connect(shard);
        const reader = new SseReader(a.response);

        await reader.next();
        await control(shard, { action: "subscribe", stream: "s", connectionId: a.connectionId, subscriptionId: "s1", topic: "feed" });

        const delivered = await shard.publishFromAction("feed", { event: "job_done" }, { stream: "s" });

        expect(delivered).toBe(1);
        await expect(reader.next()).resolves.toEqual({ data: { data: { event: "job_done" }, topic: "feed" }, event: "live" });
    });

    it("encodes an action publish exactly as the HTTP route's wire payload, so bigint survives the hop", async () => {
        expect.assertions(2);

        const viaAction = makeShard([]);
        const viaHttp = makeShard([]);
        const actionConn = await connect(viaAction);
        const httpConn = await connect(viaHttp);
        const actionReader = new SseReader(actionConn.response);
        const httpReader = new SseReader(httpConn.response);

        await actionReader.next();
        await httpReader.next();
        await control(viaAction, { action: "subscribe", stream: "s", connectionId: actionConn.connectionId, subscriptionId: "s1", topic: "t" });
        await control(viaHttp, { action: "subscribe", stream: "s", connectionId: httpConn.connectionId, subscriptionId: "s1", topic: "t" });

        await viaAction.publishFromAction("t", { amount: 5n }, { stream: "s" });
        await publish(viaHttp, { data: encodeWire({ amount: 5n }), stream: "s", topic: "t" });

        const fromAction = await actionReader.next();
        const fromHttp = await httpReader.next();

        expect(fromAction.data).toEqual(fromHttp.data);
        expect(fromAction.data).toEqual({ data: encodeWire({ amount: 5n }), topic: "t" });
    });

    it("keeps an action publish on its own stream: a subscriber of another stream receives nothing", async () => {
        expect.assertions(2);

        const shard = makeShard([]);
        const a = await connect(shard);
        const reader = new SseReader(a.response);

        await reader.next();
        await control(shard, { action: "subscribe", stream: "public", connectionId: a.connectionId, subscriptionId: "s1", topic: "feed" });

        const elsewhere = await shard.publishFromAction("feed", "private", { stream: "private" });
        const own = await shard.publishFromAction("feed", "public", { stream: "public" });

        expect(elsewhere).toBe(0);
        expect(own).toBe(1);
    });

    it("refuses an action publish to a room topic", async () => {
        expect.assertions(1);

        const shard = makeShard([]);

        await expect(shard.publishFromAction("room:chat", "forged", { stream: "s" })).rejects.toMatchObject({ code: "FORBIDDEN_TOPIC", status: 403 });
    });

    it("refuses an oversized action publish rather than dropping it", async () => {
        expect.assertions(1);

        const shard = makeShard([]);

        await expect(shard.publishFromAction("feed", "x".repeat(8192), { stream: "s" })).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE", status: 413 });
    });

    it("refuses an action publish naming a shard other than the one it runs on", async () => {
        expect.assertions(1);

        const shard = makeShard([]);

        await expect(shard.publishFromAction("feed", "x", { shardKey: "some-other-shard", stream: "s" })).rejects.toMatchObject({ status: 400 });
    });
});
