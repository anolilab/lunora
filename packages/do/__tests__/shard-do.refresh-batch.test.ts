/**
 * A write that changes several subscriptions on one socket reaches a client that
 * announced `refreshBatch` inside one `batchStart`/`batchEnd` bracket, so it can
 * apply them together. A client that did not announce it gets the frames bare.
 */
import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { describe, expect, it } from "vitest";

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

class BatchShard extends ShardDO {
    public readonly results = new Map<string, unknown>();

    public override async handleRpc(): Promise<unknown> {
        this.recordChangedTable("messages");

        return { ok: true };
    }

    public register(ws: FakeWebSocket): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment({ subs: {} });
    }

    public drive(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
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

    protected override executeSubscription(functionPath: string): Promise<SubscriptionOutcome | null> {
        return Promise.resolve({ result: this.results.get(functionPath), tables: new Set(["messages"]) });
    }
}

const types = (ws: FakeWebSocket): string[] => ws.sent.map((line) => (JSON.parse(line) as { type: string }).type);

const setUp = async (caps: string[] | undefined, functionPaths: string[]): Promise<{ shard: BatchShard; ws: FakeWebSocket }> => {
    const shard = new BatchShard(createFakeState(), {});
    const ws = createFakeWebSocket();

    shard.register(ws);
    await shard.drive(ws, { ...(caps === undefined ? {} : { caps }), id: "connect", type: "connect" });

    for (const [index, functionPath] of functionPaths.entries()) {
        shard.results.set(functionPath, index);
        // eslint-disable-next-line no-await-in-loop -- subscribes are applied in order, as a client sends them
        await shard.drive(ws, { id: `sub-${String(index)}`, query: { args: {}, functionPath }, type: "subscribe" });
    }

    ws.sent.length = 0;

    for (const [index, functionPath] of functionPaths.entries()) {
        shard.results.set(functionPath, index + 100);
    }

    return { shard, ws };
};

describe("refresh batch bracket", () => {
    it("brackets every frame one write sends to a socket that announced refreshBatch", async () => {
        expect.assertions(1);

        const { shard, ws } = await setUp(["refreshBatch"], ["messages:count", "messages:list"]);

        await shard.write();

        expect(types(ws)).toStrictEqual(["batchStart", "data", "data", "batchEnd"]);
    });

    it("sends the frames bare to a socket that did not announce refreshBatch", async () => {
        expect.assertions(1);

        const { shard, ws } = await setUp(undefined, ["messages:count", "messages:list"]);

        await shard.write();

        expect(types(ws)).toStrictEqual(["data", "data"]);
    });

    it("does not bracket a socket holding a single subscription", async () => {
        expect.assertions(1);

        const { shard, ws } = await setUp(["refreshBatch"], ["messages:count"]);

        await shard.write();

        expect(types(ws)).toStrictEqual(["data"]);
    });
});
