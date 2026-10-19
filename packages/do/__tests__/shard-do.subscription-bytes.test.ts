import type { SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it } from "vitest";

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

/** A shard whose queries return a payload of a size the test chooses. */
class BlobShard extends ShardDO {
    public readonly sizes = new Map<string, number>();

    public override async handleRpc(): Promise<unknown> {
        this.recordChangedTable("blobs");

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

    public subscribeTo(ws: FakeWebSocket, id: string, functionPath: string): Promise<void> {
        const envelope: SubscriptionEnvelope = { id, query: { args: {}, functionPath }, type: "subscribe" };

        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    protected override executeSubscription(functionPath: string): Promise<SubscriptionOutcome | null> {
        return Promise.resolve({ result: [{ blob: "x".repeat(this.sizes.get(functionPath) ?? 10) }], tables: new Set(["blobs"]) });
    }
}

const framesOf = (ws: FakeWebSocket, type: string, id?: string): { code?: string; id: string }[] =>
    ws.sent
        .map((line) => JSON.parse(line) as { code?: string; id: string; type: string })
        .filter((frame) => frame.type === type && (id === undefined || frame.id === id));

describe("shardDO: subscription byte bounds", () => {
    let ws: FakeWebSocket;

    beforeEach(() => {
        ws = createFakeWebSocket();
    });

    it("refuses to seed a subscription whose result exceeds the byte cap", async () => {
        expect.assertions(4);

        const shard = new BlobShard(createFakeState(), { LUNORA_SUBSCRIPTION_MAX_RESULT_CHARS: "1000" });

        shard.registerSocket(ws);
        shard.sizes.set("blobs:huge", 5000);
        await shard.subscribeTo(ws, "huge", "blobs:huge");

        const errors = framesOf(ws, "error", "huge");

        expect(framesOf(ws, "data", "huge")).toHaveLength(0);
        expect(errors).toHaveLength(1);
        expect(errors[0]?.code).toBe("SUBSCRIPTION_RESULT_TOO_LARGE");
        // The subscription is not left registered to be re-run on every flush.
        expect(Object.keys((ws.attachment as SocketAttachment).subs)).toStrictEqual([]);
    });

    it("ends a subscription whose refreshed result grew past the byte cap instead of leaving it silently stale", async () => {
        expect.assertions(4);

        const shard = new BlobShard(createFakeState(), { LUNORA_SUBSCRIPTION_MAX_RESULT_CHARS: "1000" });

        shard.registerSocket(ws);
        shard.sizes.set("blobs:grows", 100);
        await shard.subscribeTo(ws, "grows", "blobs:grows");

        expect(framesOf(ws, "data", "grows")).toHaveLength(1);

        shard.sizes.set("blobs:grows", 5000);
        await shard.write();

        const errors = framesOf(ws, "error", "grows");

        expect(errors).toHaveLength(1);
        expect(errors[0]?.code).toBe("SUBSCRIPTION_RESULT_TOO_LARGE");
        // Deregistered, so no later flush re-runs and re-encodes the oversized result.
        expect(Object.keys((ws.attachment as SocketAttachment).subs)).toStrictEqual([]);
    });

    it("seeds a result under the cap as before", async () => {
        expect.assertions(2);

        const shard = new BlobShard(createFakeState(), { LUNORA_SUBSCRIPTION_MAX_RESULT_CHARS: "1000" });

        shard.registerSocket(ws);
        shard.sizes.set("blobs:small", 100);
        await shard.subscribeTo(ws, "small", "blobs:small");

        expect(framesOf(ws, "data", "small")).toHaveLength(1);
        expect(framesOf(ws, "error", "small")).toHaveLength(0);
    });

    it("drops the diff baseline past the per-socket memo cap and re-sends instead of suppressing", async () => {
        expect.assertions(3);

        // Each result fits the per-result cap; three of them do not fit the memo cap together.
        const shard = new BlobShard(createFakeState(), { LUNORA_SUBSCRIPTION_MAX_RESULT_CHARS: "10000", LUNORA_SUBSCRIPTION_MEMO_MAX_CHARS: "2500" });

        shard.registerSocket(ws);

        for (const id of ["a", "b", "c"]) {
            shard.sizes.set(`blobs:${id}`, 1000);
            // eslint-disable-next-line no-await-in-loop -- seeds are sequential so memo accounting is deterministic
            await shard.subscribeTo(ws, id, `blobs:${id}`);
        }

        const before = { a: framesOf(ws, "data", "a").length, c: framesOf(ws, "data", "c").length };

        // An identical result is normally suppressed against the memo baseline.
        await shard.write();

        // `a` kept its baseline (suppressed); `c` was over the cap, has none, so the value is sent again.
        expect(framesOf(ws, "data", "a")).toHaveLength(before.a);
        expect(framesOf(ws, "data", "c")).toHaveLength(before.c + 1);
        // Still correct and live: the re-send is a full snapshot, not a delta against nothing.
        expect(framesOf(ws, "delta", "c")).toHaveLength(0);
    });
});
