import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
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
            return Promise.reject(new Error("handler bug"));
        }

        return Promise.resolve({ result: [{ _id: String(this.value) }], tables: new Set(["messages"]) });
    }
}

const frames = (ws: FakeWebSocket, type: string): { code?: string; id: string }[] =>
    ws.sent.map((line) => JSON.parse(line) as { code?: string; id: string; type: string }).filter((frame) => frame.type === type);

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
        expect(shard.runs - seedRuns).toBeLessThanOrEqual(2);
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
});
