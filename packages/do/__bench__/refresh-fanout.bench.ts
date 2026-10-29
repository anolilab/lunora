import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ShardDO } from "../src/shard-do";

/**
 * One write's live-query re-run across N sockets watching the SAME query under
 * the SAME identity.
 *
 * Each socket used to re-run the handler, re-encode its result and diff it, so a
 * flush cost N handler runs. Sockets with an equal full identity now share one
 * run and one wire encode; only the per-socket diff + send remains N-wide. The
 * slope across 10 -> 500 sockets is that per-socket residue.
 *
 * The handler is an in-memory 50-row build (no SQL): the point is the number of
 * times it runs, not the storage engine behind it.
 */

interface FakeWebSocket {
    attachment: SocketAttachment | undefined;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    return {
        attachment: undefined,
        deserializeAttachment() {
            return this.attachment;
        },
        send(_data: string) {
            /* discard — the flush is what is measured, not socket IO */
        },
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
    };
};

// No `waitUntil`: a flush is awaited inline, so one `fetch` measures one complete pass.
const createFakeState = (): ShardDOState => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws: WebSocket) {
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

class RefreshBenchShard extends ShardDO {
    private writes = 0;

    public override handleRpc(): Promise<unknown> {
        this.writes += 1;
        this.recordChangedTable("messages");

        return Promise.resolve({ ok: true });
    }

    public addSubscriber(subId: string): Promise<void> {
        const ws = createFakeWebSocket();
        const envelope: SubscriptionEnvelope = { id: subId, query: { args: {}, functionPath: "messages:list" }, type: "subscribe" };

        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment({ identity: { userId: "u1" }, subs: {}, userId: "u1" });

        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    protected override executeSubscription(): Promise<SubscriptionOutcome | null> {
        // A different result per write so every refresh is a real delta, never the unchanged-result suppression path.
        const rows = Array.from({ length: 50 }, (_, index) => {
            return { _id: `m${String(index)}`, text: "x".repeat(256), version: this.writes };
        });

        return Promise.resolve({ result: rows, tables: new Set(["messages"]) });
    }
}

const buildShard = async (sockets: number): Promise<RefreshBenchShard> => {
    const shard = new RefreshBenchShard(createFakeState(), {});

    for (let index = 0; index < sockets; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential subscribe keeps setup deterministic
        await shard.addSubscriber(`sub-${String(index)}`);
    }

    return shard;
};

const write = (shard: RefreshBenchShard): Promise<Response> =>
    shard.fetch(
        new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "mutation:write" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

const few = await buildShard(10);
const many = await buildShard(100);
const crowd = await buildShard(500);

describe("live-query refresh fan-out — one write, N sockets on the SAME query and identity", () => {
    bench("10 sockets", async () => {
        await write(few);
    });

    bench("100 sockets", async () => {
        await write(many);
    });

    bench("500 sockets", async () => {
        await write(crowd);
    });
});
