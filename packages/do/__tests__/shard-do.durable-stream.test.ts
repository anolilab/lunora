/**
 * Durable streams: the run outlives the socket that opened it.
 *
 * These are the three properties the feature exists for — a reload resumes
 * mid-run instead of losing the work, a second viewer shares one producer
 * instead of paying for a second generation, and a run the DO lost is reported
 * rather than silently re-run.
 */
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { migrateDurableStreams } from "@lunora/shard-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ShardDOState } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";
import createSqliteExec from "./_helpers/node-sqlite";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {return {
    attachment: undefined,
    send(data: string) {
        this.sent.push(data);
    },
    sent: [],
    serializeAttachment(value: unknown) {
        this.attachment = value as SocketAttachment | undefined;
    },
}};

const parseFrames = (ws: FakeWebSocket) => ws.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

const waitForTerminator = async (ws: FakeWebSocket, deadlineMs = 500): Promise<void> => {
    const start = Date.now();

    while (Date.now() - start < deadlineMs) {
        if (parseFrames(ws).some((frame) => frame.type === "complete" || frame.type === "error")) {
            return;
        }

        // eslint-disable-next-line no-await-in-loop -- polling loop must wait between frame checks
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
        });
    }
};

/** A ShardDO whose streams are all declared durable, with test-supplied generators. */
class DurableStreamShard extends ShardDO {
    public registered = new Map<string, (args: Record<string, unknown>, signal: AbortSignal) => AsyncIterable<unknown>>();

    /** How many times a generator was actually constructed — the "one producer" assertion. */
    public starts = 0;

    // eslint-disable-next-line class-methods-use-this -- override stub; these tests never dispatch a plain RPC
    public override async handleRpc(): Promise<unknown> {
        return null;
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    protected override executeStream(
        functionPath: string,
        args: Record<string, unknown>,
    ): null | { durable?: { ttlMs?: number }; iterator: (signal: AbortSignal) => AsyncIterable<unknown> } {
        const fn = this.registered.get(functionPath);

        if (!fn) {
            return null;
        }

        return {
            durable: {},
            iterator: (signal) => {
                this.starts += 1;

                return fn(args, signal);
            },
        };
    }
}

describe("shardDO durable streams", () => {
    let database: ReturnType<typeof createSqliteExec>;
    let sockets: FakeWebSocket[];
    let state: ShardDOState;

    beforeEach(() => {
        database = createSqliteExec();
        // The real path creates these in the schema migration; these tests drive
        // `executeStream` directly, so create them the same way it would.
        migrateDurableStreams(database.sql);

        sockets = [];
        state = {
            acceptWebSocket(ws: WebSocket) {
                sockets.push(ws as unknown as FakeWebSocket);
            },
            getWebSockets(): WebSocket[] {
                return sockets as unknown as WebSocket[];
            },
            id: { name: "shard-durable-stream" },
            storage: { sql: database.sql as unknown as ShardDOState["storage"]["sql"] },
        };
    });

    afterEach(() => {
        database.close();
    });

    it("replays only the chunks after sinceChunk when a client reattaches", async () => {
        expect.assertions(3);

        const shard = new DurableStreamShard(state, {});

        shard.registered.set("chat:answer", async function* answer() {
            yield "the";
            yield " quick";
            yield " fox";
        });

        const first = createFakeWebSocket();

        shard.registerSocket(first, { subs: {} });
        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(first);

        // Every chunk carries its position so a client knows what to resume from.
        expect(parseFrames(first).filter((frame) => frame.type === "chunk")).toStrictEqual([
            { data: "the", id: "stream_1", seq: 1, type: "chunk" },
            { data: " quick", id: "stream_1", seq: 2, type: "chunk" },
            { data: " fox", id: "stream_1", seq: 3, type: "chunk" },
        ]);

        // A reload: same args, same run, resuming after the first chunk.
        const resumed = createFakeWebSocket();

        shard.registerSocket(resumed, { subs: {} });
        await shard.driveMessage(resumed, { id: "stream_9", query: { functionPath: "chat:answer" }, sinceChunk: 1, type: "stream" });
        await waitForTerminator(resumed);

        const frames = parseFrames(resumed);

        expect(frames.filter((frame) => frame.type === "chunk").map((frame) => frame.data)).toStrictEqual([" quick", " fox"]);
        // The transcript was replayed from SQLite — the handler never ran again.
        expect(shard.starts).toBe(1);
    });

    it("shares one producer between two clients on the same run", async () => {
        expect.assertions(3);

        const shard = new DurableStreamShard(state, {});
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        shard.registered.set("chat:answer", async function* answer() {
            yield "first";
            await gate;
            yield "second";
        });

        const a = createFakeWebSocket();
        const b = createFakeWebSocket();

        shard.registerSocket(a, { subs: {} });
        shard.registerSocket(b, { subs: {} });

        await shard.driveMessage(a, { id: "stream_a", query: { functionPath: "chat:answer" }, type: "stream" });
        // Let the producer emit its first chunk before the second client attaches.
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        await shard.driveMessage(b, { id: "stream_b", query: { functionPath: "chat:answer" }, type: "stream" });

        release();
        await waitForTerminator(a);
        await waitForTerminator(b);

        expect(shard.starts).toBe(1);
        // The late joiner still sees the whole answer: the prefix is replayed
        // from the transcript, the rest arrives live.
        expect(
            parseFrames(a)
                .filter((frame) => frame.type === "chunk")
                .map((frame) => frame.data),
        ).toStrictEqual(["first", "second"]);
        expect(
            parseFrames(b)
                .filter((frame) => frame.type === "chunk")
                .map((frame) => frame.data),
        ).toStrictEqual(["first", "second"]);
    });

    it("reports an interrupted run instead of silently re-running the handler", async () => {
        expect.assertions(2);

        const shard = new DurableStreamShard(state, {});

        shard.registered.set("chat:answer", async function* answer() {
            yield "half";
            // Never settles: the run is still `running` when the instance dies.
            await new Promise<void>(() => {});
        });

        const first = createFakeWebSocket();

        shard.registerSocket(first, { subs: {} });
        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });

        // A fresh instance over the same storage — the in-memory producer is gone
        // but the half-written transcript survived, exactly as after an eviction.
        const revived = new DurableStreamShard(state, {});

        revived.registered = shard.registered;

        const second = createFakeWebSocket();

        revived.registerSocket(second, { subs: {} });
        await revived.driveMessage(second, { id: "stream_2", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(second);

        const frames = parseFrames(second);

        expect(frames.filter((frame) => frame.type === "chunk").map((frame) => frame.data)).toStrictEqual(["half"]);
        expect((frames.at(-1) as { error?: { code?: string } }).error?.code).toBe("STREAM_INTERRUPTED");
    });
});
