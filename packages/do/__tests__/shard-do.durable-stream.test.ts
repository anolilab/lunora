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
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
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

        shard.registerSocket(first, { clientId: "client-a", subs: {} });
        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(first);

        // Every chunk carries its position (and the run's generation stamp) so a
        // client knows what to resume from — and which run it is resuming.
        expect(parseFrames(first).filter((frame) => frame.type === "chunk")).toStrictEqual([
            { data: "the", generation: expect.any(Number) as number, id: "stream_1", seq: 1, type: "chunk" },
            { data: " quick", generation: expect.any(Number) as number, id: "stream_1", seq: 2, type: "chunk" },
            { data: " fox", generation: expect.any(Number) as number, id: "stream_1", seq: 3, type: "chunk" },
        ]);

        // A reload: same args, same run, resuming after the first chunk.
        const resumed = createFakeWebSocket();

        shard.registerSocket(resumed, { clientId: "client-a", subs: {} });
        await shard.driveMessage(resumed, { id: "stream_9", query: { functionPath: "chat:answer" }, sinceChunk: 1, type: "stream" });
        await waitForTerminator(resumed);

        const frames = parseFrames(resumed);

        expect(frames.filter((frame) => frame.type === "chunk").map((frame) => frame.data)).toStrictEqual([" quick", " fox"]);
        // The transcript was replayed from SQLite — the handler never ran again.
        expect(shard.starts).toBe(1);
    });

    it("drops a durable-run consumer whose credential lapses mid-run, without killing the run", async () => {
        expect.assertions(3);

        const shard = new DurableStreamShard(state, {});

        shard.registered.set("chat:slow", async function* slow() {
            for (let index = 0; index < 40; index += 1) {
                yield index;
                // eslint-disable-next-line no-await-in-loop -- intentional per-yield event-loop turn
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, 3);
                });
            }
        });

        const ws = createFakeWebSocket();

        // Live when the stream frame arrived, lapsed a few chunks into the run.
        shard.registerSocket(ws, { expiresAt: Date.now() + 25, subs: {} });
        await shard.driveMessage(ws, { id: "slow_1", query: { functionPath: "chat:slow" }, type: "stream" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
        });

        const frames = parseFrames(ws);

        expect(frames.some((frame) => frame.code === "TOKEN_EXPIRED")).toBe(true);
        expect(frames.filter((frame) => frame.type === "chunk").length).toBeLessThan(40);
        // The producer is durable: dropping one consumer must not abort the run.
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

        shard.registerSocket(a, { clientId: "client-a", subs: {} });
        shard.registerSocket(b, { clientId: "client-a", subs: {} });

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

    it("reports an interrupted run to a client holding half of it, and reclaims it for a fresh one", async () => {
        expect.assertions(4);

        const shard = new DurableStreamShard(state, {});

        shard.registered.set("chat:answer", async function* answer() {
            yield "half";
            // Never settles: the run is still `running` when the instance dies.
            await new Promise<void>(() => {});
        });

        const first = createFakeWebSocket();

        shard.registerSocket(first, { clientId: "client-a", subs: {} });
        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });

        // A fresh instance over the same storage — the in-memory producer is gone
        // but the half-written transcript survived, exactly as after an eviction.
        const revived = new DurableStreamShard(state, {});

        revived.registered = shard.registered;

        // A client RESUMING that transcript cannot be spliced back onto it: the
        // tail would have to be re-generated, which duplicates.
        const resumed = createFakeWebSocket();

        revived.registerSocket(resumed, { clientId: "client-a", subs: {} });
        await revived.driveMessage(resumed, { id: "stream_2", query: { functionPath: "chat:answer" }, sinceChunk: 1, type: "stream" });
        await waitForTerminator(resumed);

        expect((parseFrames(resumed).at(-1) as { error?: { code?: string } }).error?.code).toBe("STREAM_INTERRUPTED");

        // A client asking fresh has no partial transcript to protect, so the dead
        // run is reclaimed and a new one starts — an eviction must not wedge the
        // key until its TTL expires.
        revived.registered.set("chat:answer", async function* answer() {
            yield "whole";
        });

        const fresh = createFakeWebSocket();

        revived.registerSocket(fresh, { clientId: "client-a", subs: {} });
        await revived.driveMessage(fresh, { id: "stream_3", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(fresh);

        const frames = parseFrames(fresh);

        expect(frames.filter((frame) => frame.type === "chunk").map((frame) => frame.data)).toStrictEqual(["whole"]);
        expect(frames.at(-1)?.type).toBe("complete");
        // One start on the revived instance: the resuming attach refused rather
        // than re-running, and only the fresh one produced.
        expect(revived.starts).toBe(1);
    });

    it("refuses to splice a resume onto the run that replaced the one it holds a prefix of", async () => {
        expect.assertions(3);

        const shard = new DurableStreamShard(state, {});

        shard.registered.set("chat:answer", async function* answer() {
            yield "one";
            yield "two";
        });

        // Tab A watches run #1 to completion and holds its generation stamp.
        const tabA = createFakeWebSocket();

        shard.registerSocket(tabA, { clientId: "client-a", subs: {} });
        await shard.driveMessage(tabA, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(tabA);

        const { generation } = parseFrames(tabA).find((frame) => frame.type === "chunk") as { generation: number };

        // Tab B asks the same question FRESH: the finished run is reclaimed and
        // run #2 starts under the same key.
        shard.registered.set("chat:answer", async function* answer() {
            yield "alpha";
            yield "beta";
            yield "gamma";
        });

        const tabB = createFakeWebSocket();

        shard.registerSocket(tabB, { clientId: "client-a", subs: {} });
        await shard.driveMessage(tabB, { id: "stream_2", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(tabB);

        // Tab A reconnects, resuming run #1 after its second chunk. Without the
        // generation gate this would append run #2's chunk 3 onto run #1's 1..2 —
        // two different generations concatenated into one transcript.
        const resumed = createFakeWebSocket();

        shard.registerSocket(resumed, { clientId: "client-a", subs: {} });
        await shard.driveMessage(resumed, { generation, id: "stream_3", query: { functionPath: "chat:answer" }, sinceChunk: 2, type: "stream" });
        await waitForTerminator(resumed);

        const frames = parseFrames(resumed);

        expect(frames.filter((frame) => frame.type === "chunk")).toStrictEqual([]);
        expect((frames.at(-1) as { error?: { code?: string } }).error?.code).toBe("STREAM_INTERRUPTED");
        // The refusal never re-ran the handler.
        expect(shard.starts).toBe(2);
    });

    it("re-runs for a later caller instead of serving a finished transcript as a cache", async () => {
        expect.assertions(2);

        const shard = new DurableStreamShard(state, {});
        let answers = 0;

        shard.registered.set("chat:answer", async function* answer() {
            answers += 1;
            yield `answer-${String(answers)}`;
        });

        const first = createFakeWebSocket();

        shard.registerSocket(first, { clientId: "client-a", subs: {} });
        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(first);

        // Same arguments, but this caller is not resuming anything — it is asking
        // a question. Replaying the stored answer would make a durable stream a
        // response cache with a 24-hour TTL, including for a failed run.
        const later = createFakeWebSocket();

        shard.registerSocket(later, { clientId: "client-a", subs: {} });
        await shard.driveMessage(later, { id: "stream_2", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(later);

        expect(
            parseFrames(later)
                .filter((frame) => frame.type === "chunk")
                .map((frame) => frame.data),
        ).toStrictEqual(["answer-2"]);
        expect(shard.starts).toBe(2);
    });

    it("never shares a run between two anonymous callers", async () => {
        expect.assertions(2);

        const shard = new DurableStreamShard(state, {});
        let answers = 0;

        shard.registered.set("chat:answer", async function* answer() {
            answers += 1;
            yield `answer-${String(answers)}`;
        });

        const first = createFakeWebSocket();
        const second = createFakeWebSocket();

        // No `userId` on either socket. Collapsing both onto one key would hand
        // the second caller the first one's transcript without ever running the
        // handler — the same leak the identity scope closes for signed-in users.
        shard.registerSocket(first, { clientId: "client-1", subs: {} });
        shard.registerSocket(second, { clientId: "client-2", subs: {} });

        await shard.driveMessage(first, { id: "stream_1", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(first);
        await shard.driveMessage(second, { id: "stream_2", query: { functionPath: "chat:answer" }, type: "stream" });
        await waitForTerminator(second);

        expect(shard.starts).toBe(2);
        expect(
            parseFrames(second)
                .filter((frame) => frame.type === "chunk")
                .map((frame) => frame.data),
        ).toStrictEqual(["answer-2"]);
    });

    it("never shares a run across identities", async () => {
        expect.assertions(2);

        const shard = new DurableStreamShard(state, {});
        let release = (): void => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        shard.registered.set("chat:answer", async function* answer() {
            yield "secret";
            await gate;
        });

        const alice = createFakeWebSocket();
        const bob = createFakeWebSocket();

        shard.registerSocket(alice, { subs: {}, userId: "alice" });
        shard.registerSocket(bob, { subs: {}, userId: "bob" });

        await shard.driveMessage(alice, { id: "stream_a", query: { functionPath: "chat:answer" }, type: "stream" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        // Same function, same args, different verified identity: Bob must get his
        // own run, not a replay of Alice's transcript — an attach never drives the
        // procedure, so it would also skip its RLS middleware.
        await shard.driveMessage(bob, { id: "stream_b", query: { functionPath: "chat:answer" }, type: "stream" });
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 5);
        });
        release();

        expect(shard.starts).toBe(2);
        expect(parseFrames(bob).filter((frame) => frame.type === "chunk")).toHaveLength(1);
    });
});
