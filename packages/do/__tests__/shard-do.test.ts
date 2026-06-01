import { beforeEach, describe, expect, test, vi } from "vitest";

import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do.js";
import { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO } from "../src/shard-do.js";
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
        storage: { sql: { exec: vi.fn<(query: string) => unknown>(), databaseSize: options.databaseSize } },
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

    /** UserId observed by `handleRpc` on the most recent request. */
    public observedUserId: string | undefined;

    /** Identity envelope observed by `handleRpc` on the most recent request. */
    public observedIdentity: Record<string, unknown> | undefined;

    public override async handleRpc(functionPath: string, args: Record<string, unknown>): Promise<unknown> {
        this.rpcCalls.push({ functionPath, args });
        this.observedInboundBookmark = this.getInboundBookmark();
        this.observedUserId = this.getCurrentUserId();
        this.observedIdentity = this.getCurrentIdentity();

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

/**
 * Exercises the server-side re-execution path (`functionPath` subscriptions):
 * `executeSubscription` stands in for the codegen-generated override that
 * re-runs a query and reports which tables it read. Writes are simulated by
 * having `handleRpc` record a changed table, which `fetch` flushes.
 */
class ReexecShard extends ShardDO {
    /** functionPath -> the outcome `executeSubscription` should return next. */
    public readonly outcomes = new Map<string, SubscriptionOutcome>();

    /** Number of times `executeSubscription` ran (initial push + refreshes). */
    public execCount = 0;

    /** userId visible inside the most recent `handleRpc` call. */
    public userIdDuringRpc: string | undefined;

    /** userId visible inside the most recent `executeSubscription` call. */
    public userIdDuringExec: string | undefined;

    /** When set, `handleRpc` records this table as changed (simulates a write). */
    public changedTableOnRpc: string | undefined;

    public override async handleRpc(): Promise<unknown> {
        this.userIdDuringRpc = this.getCurrentUserId();

        if (this.changedTableOnRpc !== undefined) {
            this.recordChangedTable(this.changedTableOnRpc);
        }

        return { ok: true };
    }

    protected override executeSubscription(functionPath: string, args: Record<string, unknown>): Promise<SubscriptionOutcome | null> {
        void args;
        this.execCount += 1;
        this.userIdDuringExec = this.getCurrentUserId();

        const outcome = this.outcomes.get(functionPath);

        // Clone the table set so the production code can't mutate the fixture.
        return Promise.resolve(outcome ? { result: outcome.result, tables: new Set(outcome.tables) } : null);
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment: SocketAttachment = { subs: {} }): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment);
    }

    public writeRpc(headers: Record<string, string> = {}): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "cursors:updateCursor", args: {} }),
                headers: { "content-type": "application/json", ...headers },
            }),
        );
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
        expect.assertions(3);

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
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: "{not json",
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.status).toBe(400);
    });

    test("returns 500 with mapped error when handleRpc throws", async () => {
        expect.assertions(2);

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
        expect.assertions(2);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        await shard.driveMessage(ws, { type: "subscribe", id: "sub-1", query: { table: "messages" } });

        expect(ws.attachment).toEqual({ subs: { "sub-1": { table: "messages" } } });
        expect(ws.sent.at(-1)).toBe(JSON.stringify({ type: "ack", id: "sub-1" }));
    });

    test("unsubscribe clears registered subscription", async () => {
        expect.assertions(1);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: { "sub-1": { table: "messages" } } });

        await shard.driveMessage(ws, { type: "unsubscribe", id: "sub-1" });

        expect(ws.attachment).toEqual({ subs: {} });
    });

    test("broadcastDelta sends to matching subscribers only", () => {
        expect.assertions(4);

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
        expect.assertions(3);

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
        expect.assertions(2);

        const channelA = createFakeWebSocket();
        const channelB = createFakeWebSocket();

        shard.registerSocket(channelA, { subs: { "ch-a": { table: "messages", args: { channelId: "A" } } } });
        shard.registerSocket(channelB, { subs: { "ch-b": { table: "messages", args: { channelId: "B" } } } });

        shard.emit({ table: "messages", op: "delete", key: "m1" });

        expect(channelA.sent).toHaveLength(1);
        expect(channelB.sent).toHaveLength(1);
    });

    test("broadcastDelta skips when query.args requires a key absent from the row", () => {
        expect.assertions(1);

        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA, { subs: { "ch-a": { table: "messages", args: { channelId: "A" } } } });

        // `channelId` is missing from the row entirely — strict equality
        // against `undefined` rejects.
        shard.emit({ table: "messages", op: "insert", key: "m1", row: { id: "m1", text: "hi" } });

        expect(wsA.sent).toHaveLength(0);
    });

    test("matchesSubscription is overridable — subclass can implement custom predicates", () => {
        expect.assertions(2);

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
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "users:get", args: { id: "u1" } }),
            headers: { "content-type": "application/json", "x-d1-bookmark": "bm-123" },
        });

        await shard.fetch(request);

        expect(shard.observedInboundBookmark).toBe("bm-123");
    });

    test("echoes setOutboundBookmark on the response x-d1-bookmark header", async () => {
        expect.assertions(1);

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
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            method: "POST",
            body: JSON.stringify({ functionPath: "users:read", args: {} }),
            headers: { "content-type": "application/json" },
        });

        const response = await shard.fetch(request);

        expect(response.headers.get("x-d1-bookmark")).toBeNull();
    });

    test("does not leak inbound bookmark from a previous request to the next", async () => {
        expect.assertions(2);

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
        expect.assertions(2);

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
        expect.assertions(2);

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
        expect.assertions(3);

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
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ idName: "tenant-42", databaseSize: ROOT_DO_SIZE_WARN_BYTES * 2 });
        const shard = new TestShard(state, {});

        await driveRpc(shard);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    test("stays quiet on a __root__ DO below the threshold", async () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ idName: ROOT_SHARD_NAME, databaseSize: ROOT_DO_SIZE_WARN_BYTES - 1 });
        const shard = new TestShard(state, {});

        await driveRpc(shard);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });
});

describe("shardDO identity capture", () => {
    let state: ReturnType<typeof createFakeState>;
    let shard: TestShard;

    beforeEach(() => {
        state = createFakeState();
        shard = new TestShard(state, {});
    });

    test("exposes x-cirrus-userid to handlers via getCurrentUserId()", async () => {
        expect.assertions(1);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
                headers: { "content-type": "application/json", "x-cirrus-userid": "user_42" },
            }),
        );

        expect(shard.observedUserId).toBe("user_42");
    });

    test("parses x-cirrus-identity JSON envelope into a plain object", async () => {
        expect.assertions(1);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
                headers: {
                    "content-type": "application/json",
                    "x-cirrus-userid": "user_42",
                    "x-cirrus-identity": JSON.stringify({ email: "user@example.com", roles: ["admin"] }),
                },
            }),
        );

        expect(shard.observedIdentity).toEqual({ email: "user@example.com", roles: ["admin"] });
    });

    test("collapses malformed x-cirrus-identity to undefined rather than throwing", async () => {
        expect.assertions(2);

        const response = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
                headers: { "content-type": "application/json", "x-cirrus-identity": "{not json" },
            }),
        );

        expect(response.status).toBe(200);
        expect(shard.observedIdentity).toBeUndefined();
    });

    test("clears identity headers between requests so they don't leak across clients", async () => {
        expect.assertions(2);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
                headers: { "content-type": "application/json", "x-cirrus-userid": "user_42" },
            }),
        );

        expect(shard.observedUserId).toBe("user_42");

        shard.observedUserId = "polluted";
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                method: "POST",
                body: JSON.stringify({ functionPath: "messages:list", args: {} }),
                headers: { "content-type": "application/json" },
            }),
        );

        expect(shard.observedUserId).toBeUndefined();
    });
});

describe("shardDO upgrade gating", () => {
    /**
     * The Node-based test environment doesn't define `WebSocketPair`. A
     * successful gate-passing run reaches the `new WebSocketPair()` line and
     * throws; failure to pass the gate returns a 403 response. So the
     * predicate "gate passed" maps to "rejected with the WebSocketPair
     * error" — which is exactly what `expectPassedGate` asserts.
     */
    const expectPassedGate = async (shard: TestShard, request: Request): Promise<void> => {
        await expect(shard.fetch(request)).rejects.toThrow(/WebSocketPair/u);
    };

    const upgradeRequest = (url: string, init?: RequestInit): Request => {
        const headers = new Headers(init?.headers);

        headers.set("Upgrade", "websocket");

        return new Request(url, { ...init, headers });
    };

    test("allows upgrade when no origin allowlist and no bearer are configured", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), {});

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/"));
    });

    test("rejects upgrade with 403 when origin missing and allowlist configured", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { CIRRUS_ALLOWED_ORIGINS: "https://app.example" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/"));

        expect(response.status).toBe(403);
    });

    test("rejects upgrade with 403 when origin not in allowlist", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { CIRRUS_ALLOWED_ORIGINS: "https://app.example" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/", { headers: { Origin: "https://evil.example" } }));

        expect(response.status).toBe(403);
    });

    test("passes the gate when origin matches the allowlist", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { CIRRUS_ALLOWED_ORIGINS: "https://app.example,https://staging.example" });

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/", { headers: { Origin: "https://staging.example" } }));
    });

    test("rejects upgrade with 403 when bearer required but missing", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { CIRRUS_WS_BEARER: "s3cret" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/"));

        expect(response.status).toBe(403);
    });

    test("rejects upgrade with 403 when bearer token mismatches", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { CIRRUS_WS_BEARER: "s3cret" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/", { headers: { Authorization: "Bearer wrong" } }));

        expect(response.status).toBe(403);
    });

    test("accepts bearer via Authorization header", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { CIRRUS_WS_BEARER: "s3cret" });

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/", { headers: { Authorization: "Bearer s3cret" } }));
    });

    test("accepts bearer via ?token query parameter as a browser escape hatch", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { CIRRUS_WS_BEARER: "s3cret" });

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/?token=s3cret"));
    });
});

describe("shardDO subscription re-execution", () => {
    let state: ReturnType<typeof createFakeState>;

    beforeEach(() => {
        state = createFakeState();
    });

    const subscribe = async (shard: ReexecShard, ws: FakeWebSocket): Promise<void> => {
        await shard.driveMessage(ws, {
            type: "subscribe",
            id: "sub-1",
            query: { functionPath: "cursors:listCursors", args: { roomId: "lobby" }, table: "cursors" },
        });
    };

    test("pushes the initial full result on subscribe, then the refreshed result on a write to a read table", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "ack", id: "sub-1" });
        expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "data", id: "sub-1", data: [{ sessionId: "a", x: 0, y: 0 }] });

        // A write moves the cursor: the next re-execution returns the new view.
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 50, y: 80 }], tables: new Set(["cursors"]) });
        shard.changedTableOnRpc = "cursors";

        await shard.writeRpc();

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: "data", id: "sub-1", data: [{ sessionId: "a", x: 50, y: 80 }] });
    });

    test("re-executes but does not re-send when the result is byte-identical", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        const sentBefore = ws.sent.length;
        const execBefore = shard.execCount;

        // Same table changed, but the query result is unchanged.
        shard.changedTableOnRpc = "cursors";
        await shard.writeRpc();

        expect(shard.execCount).toBe(execBefore + 1); // re-ran the query
        expect(ws.sent).toHaveLength(sentBefore); // identical → deduped, no push
    });

    test("skips re-execution entirely when the write touches a table the subscription never read", async () => {
        expect.assertions(1);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        const execBefore = shard.execCount;

        shard.changedTableOnRpc = "documents";
        await shard.writeRpc();

        expect(shard.execCount).toBe(execBefore); // memo tables don't intersect → not re-run
    });

    test("re-executes anonymously — the writer's identity never leaks into the pushed view", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 1, y: 1 }], tables: new Set(["cursors"]) });
        shard.changedTableOnRpc = "cursors";

        await shard.writeRpc({ "x-cirrus-userid": "user_42" });

        expect(shard.userIdDuringRpc).toBe("user_42"); // the write saw the caller's identity
        expect(shard.userIdDuringExec).toBeUndefined(); // the re-execution did not
    });

    test("legacy subscriptions without functionPath get no initial push and never re-execute", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        await shard.driveMessage(ws, { type: "subscribe", id: "legacy", query: { table: "messages" } });

        expect(ws.sent).toHaveLength(1);
        expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "ack", id: "legacy" });

        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        expect(shard.execCount).toBe(0);
    });

    test("drops the subscription memo on unsubscribe so a later re-subscribe re-pushes", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);
        await shard.driveMessage(ws, { type: "unsubscribe", id: "sub-1" });

        const sentBefore = ws.sent.length;

        // Re-subscribe with the same id: a fresh memo means the initial result
        // is pushed again rather than deduped against the dropped one.
        await subscribe(shard, ws);

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ type: "data", id: "sub-1", data: [{ sessionId: "a", x: 0, y: 0 }] });
        expect(ws.sent.length).toBeGreaterThan(sentBefore);
    });
});
