import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do.js";
import { ShardDO } from "../src/shard-do.js";
import type { SocketAttachment, SubscriptionEnvelope } from "../src/types.js";
import createSqliteExec from "./_helpers/node-sqlite.js";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    closeCalled: boolean;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        closeCalled: false,
        deserializeAttachment() {
            return this.attachment;
        },
        send(data: string) {
            this.sent.push(data);
        },
        sent: [],
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

const parseFrames = (ws: FakeWebSocket) => ws.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

/**
 * Drive the runtime forward until either a terminating frame (`complete` /
 * `error`) lands on the socket or the deadline fires. The DO handler is
 * fire-and-forget (it returns from `webSocketMessage` before the iterator
 * drains), so tests need an explicit join point.
 */
const waitForTerminator = async (ws: FakeWebSocket, deadlineMs = 200): Promise<void> => {
    const start = Date.now();

    while (Date.now() - start < deadlineMs) {
        if (parseFrames(ws).some((f) => f.type === "complete" || f.type === "error")) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between frame checks
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
        });
    }
};

/**
 * Test ShardDO that wires `executeStream` to user-supplied async generators
 * keyed by functionPath. Lets the suite swap the iterator per case without
 * recompiling the class.
 */
class StreamShard extends ShardDO {
    public registered = new Map<string, (args: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<unknown>>();

    // eslint-disable-next-line class-methods-use-this -- override stub; the streaming tests never dispatch a plain RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public driveClose(ws: FakeWebSocket): Promise<void> {
        return this.webSocketClose(ws as unknown as WebSocket, 1000, "test", true);
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    protected override executeStream(
        functionPath: string,
        args: Record<string, unknown>,
    ): null | { iterator: (signal: AbortSignal) => AsyncIterable<unknown> } {
        const fn = this.registered.get(functionPath);

        if (!fn) {
            return null;
        }

        return { iterator: (signal) => fn(args, signal) };
    }
}

describe("shardDO streaming queries", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let sockets: FakeWebSocket[];
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        database.raw(`CREATE TABLE "messages" ("__id__" TEXT PRIMARY KEY, "text" TEXT)`);

        sockets = [];
        state = {
            acceptWebSocket(ws: WebSocket) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets(): WebSocket[] {
                return sockets as unknown as WebSocket[];
            },
            id: { name: "shard-stream" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    it("drives an async generator into ack -> chunk frames -> complete", async () => {
        expect.assertions(4);

        const shard = new StreamShard(state, {});

        shard.registered.set("metrics:tick", async function* tickGen(_args) {
            yield { tick: 1 };
            yield { tick: 2 };
            yield { tick: 3 };
        });

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: {} });
        await shard.driveMessage(ws, { id: "stream_1", query: { functionPath: "metrics:tick" }, type: "stream" });
        await waitForTerminator(ws);

        const frames = parseFrames(ws);
        const types = frames.map((f) => f.type);

        expect(types[0]).toBe("ack");
        expect(types.filter((t) => t === "chunk")).toHaveLength(3);
        expect(types.at(-1)).toBe("complete");
        expect(frames.filter((f) => f.type === "chunk").map((f) => f.data)).toEqual([{ tick: 1 }, { tick: 2 }, { tick: 3 }]);
    });

    it("client unsubscribe mid-stream aborts the iterator and stops further chunks", async () => {
        expect.assertions(3);

        const shard = new StreamShard(state, {});
        const yielded: number[] = [];

        shard.registered.set("metrics:loop", async function* loopGen(_args, signal) {
            for (let index = 0; index < 100; index += 1) {
                if (signal.aborted) {
                    return;
                }

                yielded.push(index);
                yield index;
                // Yield to the event loop so the cancel message can interleave.
                // eslint-disable-next-line no-await-in-loop -- intentional per-yield event-loop turn
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 0);
                });
            }
        });

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: {} });
        await shard.driveMessage(ws, { id: "stream_2", query: { functionPath: "metrics:loop" }, type: "stream" });

        // Wait for a couple of chunks to land before cancelling.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        await shard.driveMessage(ws, { id: "stream_2", type: "unsubscribe" });

        // Give the iterator a few ticks to honor the abort.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
        });

        const types = parseFrames(ws).map((f) => f.type);

        // Producer should have stopped well short of 100.
        expect(yielded.length).toBeLessThan(50);
        // Cancel acked, no "complete" frame for the aborted stream.
        expect(types).toContain("ack");
        expect(types).not.toContain("complete");
    });

    it("returns NOT_FOUND error when the function isn't a registered stream", async () => {
        expect.assertions(2);

        const shard = new StreamShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: {} });
        await shard.driveMessage(ws, { id: "stream_3", query: { functionPath: "missing:stream" }, type: "stream" });
        await waitForTerminator(ws);

        const errorFrame = parseFrames(ws).find((f) => f.type === "error");

        expect(errorFrame).toBeDefined();
        expect((errorFrame?.error as { code?: string }).code).toBe("NOT_FOUND");
    });

    it("admin-prefixed function path is rejected before lookup", async () => {
        expect.assertions(2);

        const shard = new StreamShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { admin: true, subs: {} });
        await shard.driveMessage(ws, { id: "stream_4", query: { functionPath: "__cirrus_admin__:tick" }, type: "stream" });

        const errorFrame = parseFrames(ws).find((f) => f.type === "error");

        expect(errorFrame).toBeDefined();
        expect(errorFrame?.message).toContain("public");
    });

    it("webSocketClose aborts in-flight streams bound to that socket", async () => {
        expect.assertions(1);

        const shard = new StreamShard(state, {});
        let abortedSignal: AbortSignal | undefined;

        shard.registered.set("metrics:hang", async function* hangGen(_args, signal) {
            abortedSignal = signal;

            // Yield once, then await an unresolved promise — the only way out
            // is the close-driven abort.
            yield 0;
            await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => {
                    resolve();
                });
            });
        });

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: {} });
        const driving = shard.driveMessage(ws, { id: "stream_5", query: { functionPath: "metrics:hang" }, type: "stream" });

        // Give the iterator a turn so its first yield lands and it's parked on the abort promise.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        await shard.driveClose(ws);
        await driving;

        expect(abortedSignal?.aborted).toBe(true);
    });

    it("a handler that throws surfaces an event-shaped error frame with code + message", async () => {
        expect.assertions(4);

        const shard = new StreamShard(state, {});

        shard.registered.set("metrics:boom", async function* boomGen() {
            yield 1;
            throw Object.assign(new Error("kaboom"), { code: "FORBIDDEN" });
        });

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: {} });
        await shard.driveMessage(ws, { id: "stream_6", query: { functionPath: "metrics:boom" }, type: "stream" });
        await waitForTerminator(ws);

        const frames = parseFrames(ws);
        const errorFrame = frames.find((f) => f.type === "error");

        expect(errorFrame).toBeDefined();
        expect((errorFrame?.error as { code?: string; message?: string })?.code).toBe("FORBIDDEN");
        expect((errorFrame?.error as { code?: string; message?: string })?.message).toBe("kaboom");
        expect(frames.filter((f) => f.type === "complete")).toHaveLength(0);
    });
});
