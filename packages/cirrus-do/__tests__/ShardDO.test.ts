import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ShardDOState } from "../src/ShardDO.js";
import { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO } from "../src/ShardDO.js";
import type { MutationDelta, SocketAttachment, SubscriptionEnvelope } from "../src/types.js";

/**
 * The Workers runtime exposes `serializeAttachment` / `deserializeAttachment`
 * as **instance methods on the WebSocket** — not on the DO state. Our fake
 * mirrors that shape so the production code can be exercised without the
 * adapter shim the workerd integration tests used to need.
 */
interface FakeWebSocket {
    addEventListener?: never;
    attachment: SocketAttachment | undefined;
    close: (code?: number, reason?: string) => void;
    closed: boolean;
    deserializeAttachment: () => unknown;
    send: (data: string) => void;
    sent: string[];
    serializeAttachment: (value: unknown) => void;
}

const createFakeWebSocket = (): FakeWebSocket => {
    const ws: FakeWebSocket = {
        sent: [],
        closed: false,
        attachment: undefined,
        send(data: string) {
            this.sent.push(data);
        },
        close() {
            this.closed = true;
        },
        serializeAttachment(value: unknown) {
            this.attachment = value as SocketAttachment | undefined;
        },
        deserializeAttachment() {
            return this.attachment;
        },
    };

    return ws;
};

interface FakeStateOptions {
    databaseSize?: number;
    idName?: string;
}

const createFakeState = (options: FakeStateOptions = {}): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];

    return {
        sockets,
        storage: { sql: { exec: vi.fn(), databaseSize: options.databaseSize } },
        id: { name: options.idName },
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
    };
};

class TestShard extends ShardDO {
    public rpcCalls: { args: Record<string, unknown>; functionPath: string }[] = [];

    public rpcResult: unknown = { ok: true };

    /** Bookmark observed by `handleRpc` on the most recent request. */
    public observedInboundBookmark: string | undefined;

    /** When set, `handleRpc` echoes this value via `setOutboundBookmark`. */
    public bookmarkToEmit: string | undefined;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.rpcCalls.push({ functionPath, args });
        this.observedInboundBookmark = this.getInboundBookmark();

        if (this.bookmarkToEmit !== undefined) {
            this.setOutboundBookmark(this.bookmarkToEmit);
        }

        return this.rpcResult;
    }

    public emit(delta: MutationDelta): void {
        this.broadcastDelta(delta);
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment = { subs: {} }): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }
}

describe("shardDO", () => {
    let state: ReturnType<typeof createFakeState>;
    let shard: TestShard;

    beforeEach(() => {
        state = createFakeState();
        shard = new TestShard(state, {});
    });

    test("dispatches RPC payloads via handleRpc and returns JSON", async () => {
        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "messages:list", args: { limit: 10 } }),
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.status).toBe(200);
        expect(shard.rpcCalls).toEqual([{ functionPath: "messages:list", args: { limit: 10 } }]);
        await expect(response.json()).resolves.toEqual({ result: { ok: true } });
    });

    test("returns 400 on malformed JSON", async () => {
        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: "{not json",
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.status).toBe(400);
    });

    test("returns 500 with mapped error when handleRpc throws", async () => {
        shard.rpcResult = undefined;
        const failing = new TestShard(state, {});

        failing.handleRpc = async () => {
            throw new Error("boom");
        };

        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "fail", args: {} }),
        });

        const response = await failing.fetch(request);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toMatchObject({ error: { code: "RPC_FAILED", message: "boom" } });
    });

    test("subscribe updates attachment registry and acks", async () => {
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        await shard.driveMessage(ws, { type: "subscribe", id: "sub-1", query: { table: "messages" } });

        expect(ws.attachment).toEqual({ subs: { "sub-1": { table: "messages" } } });
        expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "ack", id: "sub-1" }));
    });

    test("unsubscribe clears registered subscription", async () => {
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: { "sub-1": { table: "messages" } } });

        await shard.driveMessage(ws, { type: "unsubscribe", id: "sub-1" });

        expect(ws.attachment).toEqual({ subs: {} });
    });

    test("broadcastDelta sends to matching subscribers only", () => {
        const matching = createFakeWebSocket();
        const other = createFakeWebSocket();
        const unrelated = createFakeWebSocket();

        shard.registerSocket(matching, { subs: { a: { table: "messages" } } });
        shard.registerSocket(other, { subs: { b: { table: "messages" } } });
        shard.registerSocket(unrelated, { subs: { c: { table: "documents" } } });

        shard.emit({ table: "messages", op: "insert", key: "m1", row: { id: "m1" } });

        expect(matching.sent).toHaveLength(1);
        expect(other.sent).toHaveLength(1);
        expect(unrelated.sent).toHaveLength(0);
        expect(JSON.parse(matching.sent[0]!)).toMatchObject({ type: "delta", id: "a", delta: { table: "messages", op: "insert" } });
    });

    test("broadcastDelta filters by query.args — same key matches, different value skips", () => {
        const channelA = createFakeWebSocket();
        const channelB = createFakeWebSocket();
        const noFilter = createFakeWebSocket();

        shard.registerSocket(channelA, { subs: { "ch-a": { table: "messages", args: { channelId: "A" } } } });
        shard.registerSocket(channelB, { subs: { "ch-b": { table: "messages", args: { channelId: "B" } } } });
        shard.registerSocket(noFilter, { subs: { all: { table: "messages" } } });

        shard.emit({ table: "messages", op: "insert", key: "m1", row: { id: "m1", channelId: "A", text: "hi" } });

        expect(channelA.sent).toHaveLength(1);
        expect(channelB.sent).toHaveLength(0);
        expect(noFilter.sent).toHaveLength(1);
    });

    test("broadcastDelta delivers to every subscriber when delta.row is missing (delete fallback)", () => {
        const channelA = createFakeWebSocket();
        const channelB = createFakeWebSocket();

        shard.registerSocket(channelA, { subs: { "ch-a": { table: "messages", args: { channelId: "A" } } } });
        shard.registerSocket(channelB, { subs: { "ch-b": { table: "messages", args: { channelId: "B" } } } });

        shard.emit({ table: "messages", op: "delete", key: "m1" });

        expect(channelA.sent).toHaveLength(1);
        expect(channelB.sent).toHaveLength(1);
    });

    test("broadcastDelta skips when query.args requires a key absent from the row", () => {
        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA, { subs: { "ch-a": { table: "messages", args: { channelId: "A" } } } });

        // `channelId` is missing from the row entirely — strict equality
        // against `undefined` rejects.
        shard.emit({ table: "messages", op: "insert", key: "m1", row: { id: "m1", text: "hi" } });

        expect(wsA.sent).toHaveLength(0);
    });

    test("matchesSubscription is overridable — subclass can implement custom predicates", () => {
        class PrefixShard extends TestShard {
            // Match only when `row.text` starts with `args.prefix`.
            protected override matchesSubscription(
                query: { args?: Record<string, unknown>; table: string },
                delta: { row?: Record<string, unknown>; table: string },
            ): boolean {
                if (query.table !== delta.table) {
                    return false;
                }

                const prefix = query.args?.["prefix"];
                const text = delta.row?.["text"];

                if (typeof prefix !== "string" || typeof text !== "string") {
                    return false;
                }

                return text.startsWith(prefix);
            }
        }

        const custom = new PrefixShard(state, {});
        const ws = createFakeWebSocket();

        custom.registerSocket(ws, { subs: { p: { table: "messages", args: { prefix: "hi" } } } });

        custom.emit({ table: "messages", op: "insert", key: "m1", row: { id: "m1", text: "hi there" } });
        custom.emit({ table: "messages", op: "insert", key: "m2", row: { id: "m2", text: "bye" } });

        expect(ws.sent).toHaveLength(1);
        expect(JSON.parse(ws.sent[0]!)).toMatchObject({ type: "delta", id: "p" });
    });

    test("exposes inbound x-d1-bookmark to handleRpc via getInboundBookmark()", async () => {
        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "users:get", args: { id: "u1" } }),
            headers: { "content-type": "application/json", "x-d1-bookmark": "bm-123" },
        });

        await shard.fetch(request);

        expect(shard.observedInboundBookmark).toBe("bm-123");
    });

    test("echoes setOutboundBookmark on the response x-d1-bookmark header", async () => {
        shard.bookmarkToEmit = "bm-after-write";
        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "users:create", args: {} }),
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.headers.get("x-d1-bookmark")).toBe("bm-after-write");
    });

    test("omits x-d1-bookmark when the handler does not call setOutboundBookmark", async () => {
        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "users:read", args: {} }),
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.headers.get("x-d1-bookmark")).toBeNull();
    });

    test("does not leak inbound bookmark from a previous request to the next", async () => {
        // First request: bookmark present, handler observes it.
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "users:read", args: {} }),
                headers: { "content-type": "application/json", "x-d1-bookmark": "bm-1" },
            }),
        );

        expect(shard.observedInboundBookmark).toBe("bm-1");

        // Second request: no bookmark on the wire — handler must see undefined,
        // not the stale value left by the first call.
        shard.observedInboundBookmark = "polluted";
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "users:read", args: {} }),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(shard.observedInboundBookmark).toBeUndefined();
    });

    test("clears outbound bookmark between requests so a stale value never re-emits", async () => {
        shard.bookmarkToEmit = "bm-once";
        const first = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "users:create", args: {} }),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(first.headers.get("x-d1-bookmark")).toBe("bm-once");

        // Second handler invocation does not set a bookmark — the response
        // must not carry the previous request's value.
        shard.bookmarkToEmit = undefined;
        const second = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "users:read", args: {} }),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(second.headers.get("x-d1-bookmark")).toBeNull();
    });

    test("webSocketClose clears attachment without re-closing the socket", async () => {
        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: { x: { table: "messages" } } });

        await shard.webSocketClose(ws as unknown as WebSocket, 1000, "bye", true);

        expect(ws.attachment).toBeUndefined();
        // The runtime owns lifecycle here; calling ws.close() again would
        // throw "WebSocket has been closed" in the Workers runtime.
        expect(ws.closed).toBe(false);
    });
});

describe("shardDO __root__ 1 GB warning", () => {
    beforeEach(() => {
        // The "warned once" flag is process-global; reset between tests so
        // each case can observe the very first emission.
        ShardDO.resetRootSizeWarning();
    });

    const driveRpc = async (shard: TestShard): Promise<void> => {
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ functionPath: "noop", args: {} }),
            }),
        );
    };

    test("logs once when the __root__ DO crosses 1 GiB and stays quiet on subsequent writes", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ idName: ROOT_SHARD_NAME, databaseSize: ROOT_DO_SIZE_WARN_BYTES });
        const shard = new TestShard(state, {});

        await driveRpc(shard);
        await driveRpc(shard);
        await driveRpc(shard);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("__root__");
        expect(warn.mock.calls[0]?.[0]).toContain("/concepts/sharding");

        warn.mockRestore();
    });

    test("stays quiet on non-root DOs even at the same size", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ idName: "tenant-42", databaseSize: ROOT_DO_SIZE_WARN_BYTES * 2 });
        const shard = new TestShard(state, {});

        await driveRpc(shard);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    test("stays quiet on a __root__ DO below the threshold", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ idName: ROOT_SHARD_NAME, databaseSize: ROOT_DO_SIZE_WARN_BYTES - 1 });
        const shard = new TestShard(state, {});

        await driveRpc(shard);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });
});
