import { LunoraError } from "@lunora/errors";
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { encodeWire } from "@lunora/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    close: () => void;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        close() {},
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

const createFakeState = (): ShardDOState => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        storage: {
            sql: {
                exec() {
                    return { one: () => undefined, toArray: () => [], [Symbol.iterator]: Array.prototype[Symbol.iterator].bind([]) };
                },
            },
        },
    };
};

/**
 * `messages:flaky` seeds cleanly, then throws on every refresh until `failing`
 * is cleared — the shape of a handler with a deterministic bug, or a transient
 * outage that later heals.
 */
class FlakyShard extends ShardDO {
    public failing = false;

    public failure: Error = new Error("handler bug");

    public returnsNull = false;

    public runs = 0;

    public value = 1;

    public override async handleRpc(): Promise<unknown> {
        this.recordChangedTable("messages");

        return { ok: true };
    }

    public write(): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    }

    public registerSocket(ws: FakeWebSocket): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment({ subs: {} });
    }

    public subscribeFlaky(ws: FakeWebSocket, id = "sub", args: Record<string, unknown> = {}): Promise<void> {
        const envelope: SubscriptionEnvelope = { id, query: { args, functionPath: "messages:flaky" }, type: "subscribe" };

        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    protected override executeSubscription(): Promise<SubscriptionOutcome | null> {
        this.runs += 1;

        if (this.failing) {
            return Promise.reject(this.failure);
        }

        if (this.returnsNull) {
            return Promise.resolve(null);
        }

        return Promise.resolve({ result: [{ _id: String(this.value) }], tables: new Set(["messages"]) });
    }
}

/** Holds the next run until `release`, then answers it cleanly: a seed still in flight when later frames arrive. */
class HeldSeedShard extends FlakyShard {
    public hold: Promise<void> | undefined;

    protected override async executeSubscription(): Promise<SubscriptionOutcome | null> {
        const { hold } = this;

        if (hold === undefined) {
            return super.executeSubscription();
        }

        this.hold = undefined;
        await hold;
        this.runs += 1;

        return { result: [{ _id: "held" }], tables: new Set(["messages"]) };
    }
}

const frames = (ws: FakeWebSocket, type: string): { code?: string; id: string }[] =>
    ws.sent.map((line) => JSON.parse(line) as { code?: string; id: string; type: string }).filter((frame) => frame.type === type);

interface ErrorFrame {
    error?: { code: string; retryAfterMs?: number };
    id: string;
    type: string;
}

const errorFrames = (ws: FakeWebSocket): ErrorFrame[] => ws.sent.map((line) => JSON.parse(line) as ErrorFrame).filter((frame) => frame.type === "error");

describe("shardDO: failing subscription backoff", () => {
    let shard: FlakyShard;
    let ws: FakeWebSocket;

    beforeEach(async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        shard = new FlakyShard(createFakeState(), {});
        ws = createFakeWebSocket();
        shard.registerSocket(ws);
        await shard.subscribeFlaky(ws);
        shard.failing = true;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("stops re-running a deterministically failing query on every write flush", async () => {
        expect.assertions(1);

        const seedRuns = shard.runs;

        for (let write = 0; write < 10; write += 1) {
            // eslint-disable-next-line no-await-in-loop -- writes are sequential
            await shard.write();
        }

        // First failure retries on the next flush (it may be transient); after
        // that the subscription is latched and skipped until its backoff elapses.
        expect(shard.runs - seedRuns).toBe(2);
    });

    it("tells the client once, not once per flush", async () => {
        expect.assertions(2);

        for (let write = 0; write < 5; write += 1) {
            // eslint-disable-next-line no-await-in-loop -- writes are sequential
            await shard.write();
        }

        const errors = frames(ws, "error");

        expect(errors).toHaveLength(1);
        expect(errors[0]?.id).toBe("sub");
    });

    it("tells the client when a re-run crosses a transaction limit", async () => {
        expect.assertions(1);

        shard.failure = new LunoraError("TRANSACTION_LIMIT_EXCEEDED", "this transaction read 40000000 bytes, over the 33554432-byte limit");

        await shard.write();
        await shard.write();

        expect(frames(ws, "error").map((frame) => frame.code)).toStrictEqual(["TRANSACTION_LIMIT_EXCEEDED"]);
    });

    it("retries once the backoff has elapsed and recovers when the query heals", async () => {
        expect.assertions(3);

        await shard.write();
        await shard.write();

        const latchedRuns = shard.runs;

        await shard.write();

        expect(shard.runs).toBe(latchedRuns);

        shard.failing = false;
        shard.value = 2;
        vi.setSystemTime(Date.now() + 120_000);
        await shard.write();

        expect(shard.runs).toBe(latchedRuns + 1);
        // The healed query delivers its value again, so the latch is cleared.
        expect(frames(ws, "data").length + frames(ws, "delta").length).toBeGreaterThan(1);
    });

    it("forgets the failure streak when the query recovers by resolving to nothing to deliver", async () => {
        expect.assertions(2);

        await shard.write();
        await shard.write();

        // The window has elapsed and the query now resolves cleanly — to null.
        shard.failing = false;
        shard.returnsNull = true;
        vi.setSystemTime(Date.now() + 120_000);
        await shard.write();

        const recoveredRuns = shard.runs;

        // A fresh failure is a first failure again: it retries on the next flush instead of inheriting the old streak's delay.
        shard.failing = true;
        await shard.write();
        await shard.write();

        expect(shard.runs - recoveredRuns).toBe(2);
        expect(frames(ws, "error")).toHaveLength(2);
    });

    it("retries immediately when the subscription is re-registered with new args", async () => {
        expect.assertions(1);

        await shard.write();
        await shard.write();
        await shard.write();

        shard.failing = false;
        await shard.subscribeFlaky(ws, "sub", { other: true });

        const runsBefore = shard.runs;

        await shard.write();

        expect(shard.runs).toBe(runsBefore + 1);
    });

    it("hints the client on the first failure and stays silent while the streak continues", async () => {
        expect.assertions(2);

        await shard.write();
        await shard.write();

        const errors = errorFrames(ws);

        expect(errors).toHaveLength(1);
        expect(errors[0]?.error?.retryAfterMs).toBe(1000);
    });

    it("re-runs a same-args re-subscribe of a failing query and starts a new streak once it has healed", async () => {
        expect.assertions(3);

        await shard.write();

        shard.failing = false;
        shard.value = 2;
        const runsBefore = shard.runs;

        await shard.subscribeFlaky(ws);

        expect(shard.runs).toBe(runsBefore + 1);
        expect(frames(ws, "data")).toHaveLength(2);

        // The seed succeeded, so the streak is over: the next failure is a first failure again, with the first hint.
        shard.failing = true;
        await shard.write();

        const errors = errorFrames(ws);

        expect(errors.at(-1)?.error?.retryAfterMs).toBe(1000);
    });

    it("keeps a failing re-subscribe registered and answers with the next, longer hint", async () => {
        expect.assertions(5);

        await shard.write();
        await shard.subscribeFlaky(ws);

        const afterRetry = errorFrames(ws);

        expect(afterRetry.map((frame) => frame.error?.code)).toStrictEqual(["SUBSCRIPTION_REFRESH_FAILED", "SUBSCRIPTION_REFRESH_FAILED"]);
        expect(afterRetry[1]?.error?.retryAfterMs).toBe(1000);

        await shard.subscribeFlaky(ws);

        expect(errorFrames(ws).at(-1)?.error?.retryAfterMs).toBe(2000);
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "sub")).toBe(true);

        shard.failing = false;
        vi.setSystemTime(Date.now() + 120_000);
        const runsBefore = shard.runs;
        await shard.write();

        expect(shard.runs).toBe(runsBefore + 1);
    });

    it("keeps retrying a failing same-args re-subscribe after the object hibernates and forgets the streak", async () => {
        expect.assertions(4);

        const state = createFakeState();
        const before = new FlakyShard(state, {});
        const socket = createFakeWebSocket();

        before.registerSocket(socket);
        await before.subscribeFlaky(socket);
        before.failing = true;
        await before.write();

        // A cold wake: the subscription comes back from the socket attachment, the in-memory streak does not.
        const woken = new FlakyShard(state, {});

        woken.failing = true;
        await woken.subscribeFlaky(socket);

        const last = errorFrames(socket).at(-1);

        expect(last?.error?.code).toBe("SUBSCRIPTION_REFRESH_FAILED");
        expect(last?.error?.retryAfterMs).toBe(1000);
        expect(Object.hasOwn(socket.attachment?.subs ?? {}, "sub")).toBe(true);

        await woken.subscribeFlaky(socket);

        expect(errorFrames(socket).at(-1)?.error?.retryAfterMs).toBe(1000);
    });

    it("keeps a delta-merge re-snapshot registered when its seed fails", async () => {
        expect.assertions(2);

        // No flush has failed yet: the client re-subscribes because it could not merge a delta.
        await shard.subscribeFlaky(ws);

        expect(errorFrames(ws).at(-1)?.error?.retryAfterMs).toBe(1000);
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "sub")).toBe(true);
    });

    it("runs a backed-off subscription zero times across writes inside its window", async () => {
        expect.assertions(1);

        await shard.write();
        await shard.write();

        const latchedRuns = shard.runs;

        await shard.write();
        await shard.write();
        await shard.write();

        expect(shard.runs).toBe(latchedRuns);
    });

    it("ends a retried subscription whose re-run throws a result too large to deliver", async () => {
        expect.assertions(3);

        await shard.write();

        shard.failure = new LunoraError("SUBSCRIPTION_RESULT_TOO_LARGE", "this result is over the size limit");
        await shard.subscribeFlaky(ws);

        const last = errorFrames(ws).at(-1);

        expect(last?.error?.code).toBe("SUBSCRIPTION_RESULT_TOO_LARGE");
        expect(last?.error?.retryAfterMs).toBeUndefined();
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "sub")).toBe(false);
    });

    it("clears the streak on a re-subscribe with different args, so a failing seed is refused as a seed failure", async () => {
        expect.assertions(3);

        await shard.write();
        await shard.subscribeFlaky(ws, "sub", { other: true });

        const last = errorFrames(ws).at(-1);

        expect(last?.error?.code).toBe("SUBSCRIPTION_SEED_FAILED");
        expect(last?.error?.retryAfterMs).toBeUndefined();
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "sub")).toBe(false);
    });

    it("treats a failing re-subscribe with wire-encoded args as a retry instead of throwing", async () => {
        expect.assertions(3);

        const args = encodeWire({ at: new Date(0), n: 1n }) as Record<string, unknown>;

        shard.failing = false;
        await shard.subscribeFlaky(ws, "wire", args);
        shard.failing = true;
        await shard.write();

        await expect(shard.subscribeFlaky(ws, "wire", args)).resolves.toBeUndefined();

        const last = errorFrames(ws).findLast((frame) => frame.id === "wire");

        expect(last?.error?.retryAfterMs).toBe(1000);
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "wire")).toBe(true);
    });

    it("keeps a failure recorded while an older seed was in flight", async () => {
        expect.assertions(2);

        const held = new HeldSeedShard(createFakeState(), {});
        const socket = createFakeWebSocket();

        held.registerSocket(socket);
        await held.subscribeFlaky(socket);
        held.failing = true;
        await held.write();

        let release: () => void = () => undefined;

        held.hold = new Promise<void>((resolve) => {
            release = resolve;
        });

        const retry = held.subscribeFlaky(socket);

        // The flush fails while the retry's seed is still running.
        await held.write();
        release();
        await retry;

        await held.subscribeFlaky(socket);

        const last = errorFrames(socket).at(-1);

        expect(last?.error?.code).toBe("SUBSCRIPTION_REFRESH_FAILED");
        expect(Object.hasOwn(socket.attachment?.subs ?? {}, "sub")).toBe(true);
    });
});

describe("shardDO: failing subscription retry on a guarded socket", () => {
    it("answers a failing same-args re-subscribe with a seed error rather than nothing", async () => {
        expect.assertions(2);

        const shard = new FlakyShard(
            createFakeState(),
            {},
            {
                deliveryAuthorization: async ({ functionPath }) => {
                    return { epoch: 0, scope: functionPath };
                },
            },
        );
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        await shard.subscribeFlaky(ws);
        shard.failing = true;
        await shard.write();
        await shard.subscribeFlaky(ws);

        expect(errorFrames(ws).at(-1)?.error?.code).toBe("SUBSCRIPTION_SEED_FAILED");
        expect(Object.hasOwn(ws.attachment?.subs ?? {}, "sub")).toBe(false);
    });
});
