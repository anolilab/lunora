import type { MutationDelta, SocketAttachment, SubscriptionEnvelope } from "@lunora/shard-engine";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { encodeIdentityHeader, encodeUserIdHeader } from "../../../shared/identity-header";
import { encodeWire } from "../../../shared/wire-codec";
import type { ShardDOState, SubscriptionOutcome } from "../src/shard-do";
import { ROOT_DO_SIZE_WARN_BYTES, ROOT_SHARD_NAME, ShardDO, subscriptionListDeltas } from "../src/shard-do";

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
        attachment: undefined,
        close() {
            this.closed = true;
        },
        closed: false,
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

    return ws;
};

interface FakeStateOptions {
    databaseSize?: number;
    idName?: string;
}

const createFakeState = (options: FakeStateOptions = {}): ShardDOState & { sockets: FakeWebSocket[] } => {
    const sockets: FakeWebSocket[] = [];

    return {
        acceptWebSocket(ws) {
            sockets.push(ws as unknown as FakeWebSocket);
        },
        getWebSockets() {
            return sockets as unknown as WebSocket[];
        },
        id: { name: options.idName },
        sockets,
        storage: { sql: { databaseSize: options.databaseSize, exec: vi.fn<(query: string) => unknown>() } },
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
        this.rpcCalls.push({ args, functionPath });
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

    public registerSocket(ws: FakeWebSocket, attachment?: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment ?? { subs: {} });
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

    /** args visible inside the most recent `executeSubscription` call. */
    public argsDuringExec: Record<string, unknown> | undefined;

    /** When set, `handleRpc` records this table as changed (simulates a write). */
    public changedTableOnRpc: string | undefined;

    public override async handleRpc(): Promise<unknown> {
        this.userIdDuringRpc = this.getCurrentUserId();

        if (this.changedTableOnRpc !== undefined) {
            this.recordChangedTable(this.changedTableOnRpc);
        }

        return { ok: true };
    }

    public driveMessage(ws: FakeWebSocket, envelope: SubscriptionEnvelope): Promise<void> {
        return this.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(envelope));
    }

    public registerSocket(ws: FakeWebSocket, attachment?: SocketAttachment): void {
        this.state.acceptWebSocket(ws as unknown as WebSocket);
        ws.serializeAttachment(attachment ?? { subs: {} });
    }

    public writeRpc(headers: Record<string, string> = {}): Promise<Response> {
        return this.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "cursors:updateCursor" }),
                headers: { "content-type": "application/json", ...headers },
                method: "POST",
            }),
        );
    }

    protected override executeSubscription(
        functionPath: string,
        args: Record<string, unknown>,
        identity?: { identity?: Record<string, unknown>; userId?: string },
    ): Promise<SubscriptionOutcome | null> {
        this.execCount += 1;
        this.argsDuringExec = args;
        // Identity is now threaded EXPLICITLY by the caller (mirrors the codegen
        // `buildCtx`, which reads `options.identity` for subscriptions instead of
        // the shared per-request field). The subscription bridge always passes an
        // anonymous identity, so a concurrent RPC's `currentRequestUserId` can
        // never leak in.
        this.userIdDuringExec = identity?.userId;

        const outcome = this.outcomes.get(functionPath);

        // Clone the table set so the production code can't mutate the fixture.
        return Promise.resolve(outcome ? { result: outcome.result, tables: new Set(outcome.tables) } : null);
    }
}

describe("shardDO", () => {
    let state: ReturnType<typeof createFakeState>;
    let shard: TestShard;

    beforeEach(() => {
        state = createFakeState();
        shard = new TestShard(state, {});
    });

    it("dispatches RPC payloads via handleRpc and returns JSON", async () => {
        expect.assertions(3);

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { limit: 10 }, functionPath: "messages:list" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        const response = await shard.fetch(request);

        expect(response.status).toBe(200);
        expect(shard.rpcCalls).toEqual([{ args: { limit: 10 }, functionPath: "messages:list" }]);
        await expect(response.json()).resolves.toEqual({ result: { ok: true } });
    });

    it("returns 400 on malformed JSON", async () => {
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            body: "{not json",
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        const response = await shard.fetch(request);

        expect(response.status).toBe(400);
    });

    it("returns 500 with a redacted message when handleRpc throws", async () => {
        expect.assertions(4);

        shard.rpcResult = undefined;
        const failing = new TestShard(state, {});
        const sensitive = "table users column secret_token does not exist";

        failing.handleRpc = async () => {
            throw new Error(sensitive);
        };

        // The unhandled throw is logged server-side; the client must only see a
        // generic message. Silence + capture the diagnostic.
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "fail" }),
            method: "POST",
        });

        const response = await failing.fetch(request);

        expect(response.status).toBe(500);

        const text = await response.text();

        // The raw thrown message must never reach the client.
        expect(text).not.toContain(sensitive);
        expect(JSON.parse(text)).toMatchObject({ error: { code: "RPC_FAILED", message: "internal error" } });
        // ...but it is logged server-side for diagnosis.
        expect(errorSpy).toHaveBeenCalledWith("[@lunora/do] internal error:", expect.anything());

        errorSpy.mockRestore();
    });

    it("subscribe updates attachment registry and acks", async () => {
        expect.assertions(2);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        await shard.driveMessage(ws, { id: "sub-1", query: { table: "messages" }, type: "subscribe" });

        expect(ws.attachment).toEqual({ subs: { "sub-1": { table: "messages" } } });
        expect(ws.sent.at(-1)).toBe(JSON.stringify({ id: "sub-1", type: "ack" }));
    });

    it("unsubscribe clears registered subscription", async () => {
        expect.assertions(1);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: { "sub-1": { table: "messages" } } });

        await shard.driveMessage(ws, { id: "sub-1", type: "unsubscribe" });

        expect(ws.attachment).toEqual({ subs: {} });
    });

    it("unsubscribe rolls back when serializeAttachment throws and does not propagate the error", async () => {
        expect.assertions(2);

        const ws = createFakeWebSocket();

        shard.registerSocket(ws, { subs: { "sub-1": { table: "messages" } } });

        // Make serializeAttachment throw on the next call (simulates the
        // per-socket JSON size limit being exceeded on the shrunken payload).
        const original = ws.serializeAttachment.bind(ws);
        let callCount = 0;

        ws.serializeAttachment = (value: unknown) => {
            callCount += 1;

            if (callCount === 1) {
                throw new Error("serialize failed");
            }

            original(value);
        };

        // Must not throw.
        await shard.driveMessage(ws, { id: "sub-1", type: "unsubscribe" });

        // Subscription must still be present after the rollback.
        expect(ws.attachment).toEqual({ subs: { "sub-1": { table: "messages" } } });
        expect(callCount).toBe(1);
    });

    it("broadcastDelta sends to matching subscribers only", () => {
        expect.assertions(4);

        const matching = createFakeWebSocket();
        const other = createFakeWebSocket();
        const unrelated = createFakeWebSocket();

        shard.registerSocket(matching, { subs: { a: { table: "messages" } } });
        shard.registerSocket(other, { subs: { b: { table: "messages" } } });
        shard.registerSocket(unrelated, { subs: { c: { table: "documents" } } });

        shard.emit({ key: "m1", op: "insert", row: { id: "m1" }, table: "messages" });

        expect(matching.sent).toHaveLength(1);
        expect(other.sent).toHaveLength(1);
        expect(unrelated.sent).toHaveLength(0);
        expect(JSON.parse(matching.sent[0]!)).toMatchObject({ delta: { op: "insert", table: "messages" }, id: "a", type: "delta" });
    });

    it("broadcastDelta filters by query.args — same key matches, different value skips", () => {
        expect.assertions(3);

        const channelA = createFakeWebSocket();
        const channelB = createFakeWebSocket();
        const noFilter = createFakeWebSocket();

        shard.registerSocket(channelA, { subs: { "ch-a": { args: { channelId: "A" }, table: "messages" } } });
        shard.registerSocket(channelB, { subs: { "ch-b": { args: { channelId: "B" }, table: "messages" } } });
        shard.registerSocket(noFilter, { subs: { all: { table: "messages" } } });

        shard.emit({ key: "m1", op: "insert", row: { channelId: "A", id: "m1", text: "hi" }, table: "messages" });

        expect(channelA.sent).toHaveLength(1);
        expect(channelB.sent).toHaveLength(0);
        expect(noFilter.sent).toHaveLength(1);
    });

    it("broadcastDelta delivers to every subscriber when delta.row is missing (delete fallback)", () => {
        expect.assertions(2);

        const channelA = createFakeWebSocket();
        const channelB = createFakeWebSocket();

        shard.registerSocket(channelA, { subs: { "ch-a": { args: { channelId: "A" }, table: "messages" } } });
        shard.registerSocket(channelB, { subs: { "ch-b": { args: { channelId: "B" }, table: "messages" } } });

        shard.emit({ key: "m1", op: "delete", table: "messages" });

        expect(channelA.sent).toHaveLength(1);
        expect(channelB.sent).toHaveLength(1);
    });

    it("broadcastDelta skips when query.args requires a key absent from the row", () => {
        expect.assertions(1);

        const wsA = createFakeWebSocket();

        shard.registerSocket(wsA, { subs: { "ch-a": { args: { channelId: "A" }, table: "messages" } } });

        // `channelId` is missing from the row entirely — strict equality
        // against `undefined` rejects.
        shard.emit({ key: "m1", op: "insert", row: { id: "m1", text: "hi" }, table: "messages" });

        expect(wsA.sent).toHaveLength(0);
    });

    it("matchesSubscription is overridable — subclass can implement custom predicates", () => {
        expect.assertions(2);

        class PrefixShard extends TestShard {
            // Match only when `row.text` starts with `args.prefix`.
            // eslint-disable-next-line class-methods-use-this -- pure predicate override; the test only checks routing
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

        custom.registerSocket(ws, { subs: { p: { args: { prefix: "hi" }, table: "messages" } } });

        custom.emit({ key: "m1", op: "insert", row: { id: "m1", text: "hi there" }, table: "messages" });
        custom.emit({ key: "m2", op: "insert", row: { id: "m2", text: "bye" }, table: "messages" });

        expect(ws.sent).toHaveLength(1);
        expect(JSON.parse(ws.sent[0]!)).toMatchObject({ id: "p", type: "delta" });
    });

    it("exposes inbound x-d1-bookmark to handleRpc via getInboundBookmark()", async () => {
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: { id: "u1" }, functionPath: "users:get" }),
            headers: { "content-type": "application/json", "x-d1-bookmark": "bm-123" },
            method: "POST",
        });

        await shard.fetch(request);

        expect(shard.observedInboundBookmark).toBe("bm-123");
    });

    it("echoes setOutboundBookmark on the response x-d1-bookmark header", async () => {
        expect.assertions(1);

        shard.bookmarkToEmit = "bm-after-write";
        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "users:create" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        const response = await shard.fetch(request);

        expect(response.headers.get("x-d1-bookmark")).toBe("bm-after-write");
    });

    it("omits x-d1-bookmark when the handler does not call setOutboundBookmark", async () => {
        expect.assertions(1);

        const request = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: {}, functionPath: "users:read" }),
            headers: { "content-type": "application/json" },
            method: "POST",
        });

        const response = await shard.fetch(request);

        expect(response.headers.get("x-d1-bookmark")).toBeNull();
    });

    it("does not leak inbound bookmark from a previous request to the next", async () => {
        expect.assertions(2);

        // First request: bookmark present, handler observes it.
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "users:read" }),
                headers: { "content-type": "application/json", "x-d1-bookmark": "bm-1" },
                method: "POST",
            }),
        );

        expect(shard.observedInboundBookmark).toBe("bm-1");

        // Second request: no bookmark on the wire — handler must see undefined,
        // not the stale value left by the first call.
        shard.observedInboundBookmark = "polluted";
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "users:read" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(shard.observedInboundBookmark).toBeUndefined();
    });

    it("clears outbound bookmark between requests so a stale value never re-emits", async () => {
        expect.assertions(2);

        shard.bookmarkToEmit = "bm-once";
        const first = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "users:create" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(first.headers.get("x-d1-bookmark")).toBe("bm-once");

        // Second handler invocation does not set a bookmark — the response
        // must not carry the previous request's value.
        shard.bookmarkToEmit = undefined;
        const second = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "users:read" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );

        expect(second.headers.get("x-d1-bookmark")).toBeNull();
    });

    it("webSocketClose clears attachment without re-closing the socket", async () => {
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
                body: JSON.stringify({ args: {}, functionPath: "noop" }),
                headers: { "content-type": "application/json" },
                method: "POST",
            }),
        );
    };

    it("logs once when the __root__ DO crosses 1 GiB and stays quiet on subsequent writes", async () => {
        expect.assertions(3);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ databaseSize: ROOT_DO_SIZE_WARN_BYTES, idName: ROOT_SHARD_NAME });
        const shard = new TestShard(state, {});

        await driveRpc(shard);
        await driveRpc(shard);
        await driveRpc(shard);

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toContain("__root__");
        expect(warn.mock.calls[0]?.[0]).toContain("/concepts/sharding");

        warn.mockRestore();
    });

    it("stays quiet on non-root DOs even at the same size", async () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ databaseSize: ROOT_DO_SIZE_WARN_BYTES * 2, idName: "tenant-42" });
        const shard = new TestShard(state, {});

        await driveRpc(shard);

        expect(warn).not.toHaveBeenCalled();

        warn.mockRestore();
    });

    it("stays quiet on a __root__ DO below the threshold", async () => {
        expect.assertions(1);

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const state = createFakeState({ databaseSize: ROOT_DO_SIZE_WARN_BYTES - 1, idName: ROOT_SHARD_NAME });
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

    it("exposes x-lunora-userid to handlers via getCurrentUserId()", async () => {
        expect.assertions(1);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json", "x-lunora-userid": "user_42" },
                method: "POST",
            }),
        );

        expect(shard.observedUserId).toBe("user_42");
    });

    it("decodes a base64url-encoded x-lunora-userid (non-Latin-1) back to the original id via getCurrentUserId()", async () => {
        expect.assertions(1);

        const userId = "田中太郎";

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json", "x-lunora-userid": encodeUserIdHeader(userId) },
                method: "POST",
            }),
        );

        expect(shard.observedUserId).toBe(userId);
    });

    it("parses x-lunora-identity JSON envelope into a plain object", async () => {
        expect.assertions(1);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: {
                    "content-type": "application/json",
                    "x-lunora-identity": JSON.stringify({ email: "user@example.com", roles: ["admin"] }),
                    "x-lunora-userid": "user_42",
                },
                method: "POST",
            }),
        );

        expect(shard.observedIdentity).toEqual({ email: "user@example.com", roles: ["admin"] });
    });

    it("collapses malformed x-lunora-identity to undefined rather than throwing", async () => {
        expect.assertions(2);

        const response = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json", "x-lunora-identity": "{not json" },
                method: "POST",
            }),
        );

        expect(response.status).toBe(200);
        expect(shard.observedIdentity).toBeUndefined();
    });

    it("parses a base64url-encoded x-lunora-identity to the SAME object the legacy raw-JSON header produces (rollout order-independence)", async () => {
        expect.assertions(2);

        // Latin-1-only claims deliberately: a raw (unencoded) legacy header can
        // only ever carry Latin-1-safe content in the first place — that's the
        // bug this plan fixes — so the equivalence is only meaningful for content
        // both forms can actually transport.
        const claims = { email: "user@example.com", roles: ["admin"] };

        const legacyResponse = shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: {
                    "content-type": "application/json",
                    "x-lunora-identity": JSON.stringify(claims),
                    "x-lunora-userid": "user_42",
                },
                method: "POST",
            }),
        );

        await legacyResponse;

        const legacyObserved = shard.observedIdentity;

        const encodedResponse = await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: {
                    "content-type": "application/json",
                    "x-lunora-identity": encodeIdentityHeader(claims),
                    "x-lunora-userid": encodeUserIdHeader("user_42"),
                },
                method: "POST",
            }),
        );

        expect(encodedResponse.status).toBe(200);
        expect(shard.observedIdentity).toEqual(legacyObserved);
    });

    it("clears identity headers between requests so they don't leak across clients", async () => {
        expect.assertions(2);

        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json", "x-lunora-userid": "user_42" },
                method: "POST",
            }),
        );

        expect(shard.observedUserId).toBe("user_42");

        shard.observedUserId = "polluted";
        await shard.fetch(
            new Request("https://shard.internal/rpc", {
                body: JSON.stringify({ args: {}, functionPath: "messages:list" }),
                headers: { "content-type": "application/json" },
                method: "POST",
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

    it("allows upgrade when no origin allowlist and no bearer are configured", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), {});

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/"));
    });

    it("rejects upgrade with 403 when origin missing and allowlist configured", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { LUNORA_ALLOWED_ORIGINS: "https://app.example" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/"));

        expect(response.status).toBe(403);
    });

    it("rejects upgrade with 403 when origin not in allowlist", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { LUNORA_ALLOWED_ORIGINS: "https://app.example" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/", { headers: { Origin: "https://evil.example" } }));

        expect(response.status).toBe(403);
    });

    it("passes the gate when origin matches the allowlist", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { LUNORA_ALLOWED_ORIGINS: "https://app.example,https://staging.example" });

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/", { headers: { Origin: "https://staging.example" } }));
    });

    it("rejects upgrade with 403 when bearer required but missing", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { LUNORA_WS_BEARER: "s3cret" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/"));

        expect(response.status).toBe(403);
    });

    it("rejects upgrade with 403 when bearer token mismatches", async () => {
        expect.assertions(1);

        const shard = new TestShard(createFakeState(), { LUNORA_WS_BEARER: "s3cret" });
        const response = await shard.fetch(upgradeRequest("https://shard.internal/", { headers: { Authorization: "Bearer wrong" } }));

        expect(response.status).toBe(403);
    });

    it("accepts bearer via Authorization header", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { LUNORA_WS_BEARER: "s3cret" });

        await expectPassedGate(shard, upgradeRequest("https://shard.internal/", { headers: { Authorization: "Bearer s3cret" } }));
    });

    it("accepts bearer via ?token query parameter as a browser escape hatch", async () => {
        expect.hasAssertions();

        const shard = new TestShard(createFakeState(), { LUNORA_WS_BEARER: "s3cret" });

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
            id: "sub-1",
            query: { args: { roomId: "lobby" }, functionPath: "cursors:listCursors", table: "cursors" },
            type: "subscribe",
        });
    };

    it("pushes the initial full result on subscribe, then the refreshed result on a write to a read table", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "sub-1", type: "ack" });
        expect(JSON.parse(ws.sent[1]!)).toEqual({ data: [{ sessionId: "a", x: 0, y: 0 }], id: "sub-1", type: "data" });

        // A write moves the cursor: the next re-execution returns the new view.
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 50, y: 80 }], tables: new Set(["cursors"]) });
        shard.changedTableOnRpc = "cursors";

        await shard.writeRpc();

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ data: [{ sessionId: "a", x: 50, y: 80 }], id: "sub-1", type: "data" });
    });

    it("re-executes but does not re-send when the result is byte-identical", async () => {
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

        // Byte-identical result → no `data`/`delta` re-push; the only new frame is a
        // lightweight `settled` (carrying the cursor) so a pending optimistic overlay
        // can drop without a visible change.
        const pushed = ws.sent.slice(sentBefore).map((raw) => JSON.parse(raw));

        expect(pushed.filter((frame) => frame.type === "data" || frame.type === "delta")).toHaveLength(0);
    });

    it("skips re-execution entirely when the write touches a table the subscription never read", async () => {
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

    it("re-executes anonymously — the writer's identity never leaks into the pushed view", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);

        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 1, y: 1 }], tables: new Set(["cursors"]) });
        shard.changedTableOnRpc = "cursors";

        await shard.writeRpc({ "x-lunora-userid": "user_42" });

        expect(shard.userIdDuringRpc).toBe("user_42"); // the write saw the caller's identity
        expect(shard.userIdDuringExec).toBeUndefined(); // the re-execution did not
    });

    it("legacy subscriptions without functionPath get no initial push and never re-execute", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        await shard.driveMessage(ws, { id: "legacy", query: { table: "messages" }, type: "subscribe" });

        expect(ws.sent).toHaveLength(1);
        expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "legacy", type: "ack" });

        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        expect(shard.execCount).toBe(0);
    });

    it("drops the subscription memo on unsubscribe so a later re-subscribe re-pushes", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("cursors:listCursors", { result: [{ sessionId: "a", x: 0, y: 0 }], tables: new Set(["cursors"]) });

        await subscribe(shard, ws);
        await shard.driveMessage(ws, { id: "sub-1", type: "unsubscribe" });

        const sentBefore = ws.sent.length;

        // Re-subscribe with the same id: a fresh memo means the initial result
        // is pushed again rather than deduped against the dropped one.
        await subscribe(shard, ws);

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ data: [{ sessionId: "a", x: 0, y: 0 }], id: "sub-1", type: "data" });
        expect(ws.sent.length).toBeGreaterThan(sentBefore);
    });
});

describe("shardDO wire-typed subscription args (decode-at-entry)", () => {
    let state: ReturnType<typeof createFakeState>;

    beforeEach(() => {
        state = createFakeState();
    });

    it("decodes wire-encoded args ONCE at the subscribe entry point: attachment, seed, and re-execution all see real values", async () => {
        expect.assertions(5);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:since", { result: [], tables: new Set(["messages"]) });

        // The frame carries the client's `encodeWire` form of `{ at: Date(5000), since: 123n }`.
        await shard.driveMessage(ws, {
            id: "sub-1",
            query: {
                args: encodeWire({ at: new Date(5000), since: 123n }) as Record<string, unknown>,
                functionPath: "messages:since",
                table: "messages",
            },
            type: "subscribe",
        });

        expect(JSON.parse(ws.sent[0]!)).toEqual({ id: "sub-1", type: "ack" });
        // The seed executed with the DECODED args, not the tagged arrays.
        expect(shard.argsDuringExec).toStrictEqual({ at: new Date(5000), since: 123n });
        // The attachment stores decoded args, so hibernation (structured clone)
        // and every later consumer (re-execution, reactiveCacheKey, RLS) see them.
        expect(ws.attachment?.subs["sub-1"]?.args).toStrictEqual({ at: new Date(5000), since: 123n });

        // A write to a read table re-executes from the ATTACHMENT's stored args.
        shard.argsDuringExec = undefined;
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        expect(shard.execCount).toBe(2);
        expect(shard.argsDuringExec).toStrictEqual({ at: new Date(5000), since: 123n });
    });

    it("keeps pure-JSON subscribe envelopes byte-compatible (identity decode)", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", { result: [], tables: new Set(["messages"]) });

        await shard.driveMessage(ws, {
            id: "sub-1",
            query: { args: { channel: "general", limit: 10 }, functionPath: "messages:list", table: "messages" },
            type: "subscribe",
        });

        expect(shard.argsDuringExec).toStrictEqual({ channel: "general", limit: 10 });
        expect(ws.attachment?.subs["sub-1"]?.args).toStrictEqual({ channel: "general", limit: 10 });
    });

    it("answers a malformed tagged payload with a structured error frame instead of throwing out of webSocketMessage", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        // An over-long bigint digit string fails `decodeWire`'s DoS bound.
        await expect(
            shard.driveMessage(ws, {
                id: "sub-1",
                query: { args: { since: ["$lunora.wire$", "bigint", "9".repeat(2000)] }, functionPath: "messages:since", table: "messages" },
                type: "subscribe",
            }),
        ).resolves.toBeUndefined();

        expect(JSON.parse(ws.sent[0]!)).toEqual({
            code: "BAD_SUBSCRIPTION_ARGS",
            error: { code: "BAD_SUBSCRIPTION_ARGS", message: "subscription args failed wire decoding" },
            id: "sub-1",
            type: "error",
        });
        // Nothing was registered on the socket.
        expect(ws.attachment?.subs["sub-1"]).toBeUndefined();
    });
});

describe("subscriptionListDeltas", () => {
    const row = (id: string, rest: Record<string, unknown> = {}): Record<string, unknown> => {
        return { _creationTime: 1, _id: id, ...rest };
    };

    it("emits an insert delta for a row present only in the new result", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a")]);
        const next = [row("a"), row("b", { text: "hi" })];

        expect(subscriptionListDeltas(prev, next, "messages")).toEqual([
            { key: "b", op: "insert", row: { _creationTime: 1, _id: "b", text: "hi" }, table: "messages" },
        ]);
    });

    it("emits an update delta for a surviving row whose body changed", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a", { text: "old" })]);
        const next = [row("a", { text: "new" })];

        expect(subscriptionListDeltas(prev, next, "messages")).toEqual([
            { key: "a", op: "update", row: { _creationTime: 1, _id: "a", text: "new" }, table: "messages" },
        ]);
    });

    it("emits a delete delta (no row) for a row dropped from the new result", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a"), row("b")]);
        const next = [row("a")];

        expect(subscriptionListDeltas(prev, next, "messages")).toEqual([{ key: "b", op: "delete", table: "messages" }]);
    });

    it("emits nothing for an unchanged list (no row bodies differ)", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a"), row("b")]);
        const next = [row("a"), row("b")];

        expect(subscriptionListDeltas(prev, next, "messages")).toEqual([]);
    });

    it("returns the snapshot sentinel when the new result is not an array", () => {
        expect.assertions(1);

        expect(subscriptionListDeltas(JSON.stringify([row("a")]), { count: 1 }, "messages")).toBeUndefined();
    });

    it("returns the snapshot sentinel when the previous snapshot is not an array", () => {
        expect.assertions(1);

        expect(subscriptionListDeltas(JSON.stringify({ count: 0 }), [row("a")], "messages")).toBeUndefined();
    });

    it("returns the snapshot sentinel when any row lacks a string _id", () => {
        expect.assertions(2);

        expect(subscriptionListDeltas(JSON.stringify([{ x: 1 }]), [{ x: 2 }], "messages")).toBeUndefined();
        expect(subscriptionListDeltas(JSON.stringify([row("a")]), [row("a"), { x: 2 }], "messages")).toBeUndefined();
    });

    it("returns the snapshot sentinel when a list carries a duplicate _id (delta keying would lose rows)", () => {
        expect.assertions(2);

        // A relational join can fan one parent out across N children, producing
        // the same `_id` twice. The delta protocol keys by `_id`, so the client
        // would collapse the collisions and end up shorter than the snapshot —
        // both the new and the previous side must force the full-snapshot path.
        expect(subscriptionListDeltas(JSON.stringify([row("a")]), [row("a"), row("a", { text: "dup" })], "messages")).toBeUndefined();
        expect(subscriptionListDeltas(JSON.stringify([row("a"), row("a")]), [row("a")], "messages")).toBeUndefined();
    });

    it("returns the snapshot sentinel when surviving rows were reordered (client can't reorder in place)", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a"), row("b")]);
        const next = [row("b"), row("a")];

        expect(subscriptionListDeltas(prev, next, "messages")).toBeUndefined();
    });

    it("returns the snapshot sentinel on a near-total change where deltas would exceed the new length", () => {
        expect.assertions(1);

        // 2 deletes + 1 insert = 3 deltas for a new array of length 1 → snapshot.
        const prev = JSON.stringify([row("a"), row("b")]);
        const next = [row("c")];

        expect(subscriptionListDeltas(prev, next, "messages")).toBeUndefined();
    });

    it("falls back to a non-empty table name when the read-table set is empty", () => {
        expect.assertions(1);

        const prev = JSON.stringify([row("a")]);
        const next = [row("a"), row("b")];
        const deltas = subscriptionListDeltas(prev, next, "");

        expect(deltas?.[0]?.table).not.toBe("");
    });

    // -------------------------------------------------------------------------
    // Finding #6 — the optional `frames` sink must produce frame bodies that are
    // byte-identical to `JSON.stringify(delta)` (so the production caller can
    // splice them straight into the wire frame without re-serializing the row),
    // and each row must be stringified exactly once per refresh (no double
    // serialization across the change-detection compare and the frame payload).
    // -------------------------------------------------------------------------
    it("the frames sink yields bodies byte-identical to JSON.stringify(delta) across insert/update/delete", () => {
        expect.assertions(2);

        // One delete (c), one update (a), one insert (d) — exercises all three
        // branches while staying at/under the chattiness cap (3 deltas, length-3 next).
        const prev = JSON.stringify([row("a", { text: "old" }), row("b"), row("c")]);
        const next = [row("a", { text: "new" }), row("b"), row("d", { text: "fresh" })];

        const frames: string[] = [];
        const deltas = subscriptionListDeltas(prev, next, "messages", frames);

        expect(deltas).toBeDefined();
        // Each collected frame body must equal exactly what the old code produced
        // via `JSON.stringify(delta)` — same key order, same row serialization.
        expect(frames).toEqual((deltas ?? []).map((delta) => JSON.stringify(delta)));
    });

    it("serializes each next row exactly once per refresh (no double JSON.stringify per row)", () => {
        expect.assertions(2);

        // Spy on each next row's serialization via a counting `toJSON`. Both the
        // change-detection compare and the frame body must reuse a single
        // fingerprint, so each row's `toJSON` fires exactly once.
        const counts: Record<string, number> = { a: 0, c: 0 };
        const countingRow = (id: string, rest: Record<string, unknown>): Record<string, unknown> => {
            return {
                _creationTime: 1,
                _id: id,
                ...rest,
                toJSON() {
                    counts[id] = (counts[id] ?? 0) + 1;

                    return { _creationTime: 1, _id: id, ...rest };
                },
            };
        };

        // `a` survives with a body change (update path, runs the compare);
        // `c` is brand new (insert path, no compare). Both must be stringified once.
        const prev = JSON.stringify([row("a", { text: "old" })]);
        const next = [countingRow("a", { text: "new" }), countingRow("c", { text: "fresh" })];

        const frames: string[] = [];

        subscriptionListDeltas(prev, next, "messages", frames);

        expect(counts["a"]).toBe(1);
        expect(counts["c"]).toBe(1);
    });
});

describe("shardDO subscription delta push", () => {
    let state: ReturnType<typeof createFakeState>;

    beforeEach(() => {
        state = createFakeState();
    });

    const idRow = (id: string, rest: Record<string, unknown> = {}): Record<string, unknown> => {
        return { _creationTime: 1, _id: id, ...rest };
    };

    const subscribeMessages = (shard: ReexecShard, ws: FakeWebSocket): Promise<void> =>
        shard.driveMessage(ws, { id: "sub-1", query: { args: {}, functionPath: "messages:list" }, type: "subscribe" });

    it("first push is a data snapshot; an additive change pushes a delta frame", async () => {
        expect.assertions(3);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", { result: [idRow("a")], tables: new Set(["messages"]) });

        await subscribeMessages(shard, ws);

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ data: [idRow("a")], id: "sub-1", type: "data" });

        shard.outcomes.set("messages:list", { result: [idRow("a"), idRow("b", { text: "hi" })], tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        const last = JSON.parse(ws.sent.at(-1)!);

        expect(last).toMatchObject({ id: "sub-1", type: "delta" });
        expect(last.delta).toEqual({ key: "b", op: "insert", row: idRow("b", { text: "hi" }), table: "messages" });
    });

    it("a non-list result still pushes a data snapshot on a subsequent change", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", { result: { count: 1 }, tables: new Set(["messages"]) });

        await subscribeMessages(shard, ws);

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ data: { count: 1 }, id: "sub-1", type: "data" });

        shard.outcomes.set("messages:list", { result: { count: 2 }, tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        expect(JSON.parse(ws.sent.at(-1)!)).toEqual({ data: { count: 2 }, id: "sub-1", type: "data" });
    });

    it("applying the pushed delta frames to the prior snapshot yields the new result", async () => {
        expect.assertions(1);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);
        shard.outcomes.set("messages:list", { result: [idRow("a"), idRow("b"), idRow("c")], tables: new Set(["messages"]) });

        await subscribeMessages(shard, ws);

        const baseline = (JSON.parse(ws.sent.at(-1)!) as { data: Record<string, unknown>[] }).data;
        const sentBefore = ws.sent.length;

        // Delete c, update a, insert d — 3 deltas for a length-3 result (under the cap).
        const nextResult = [idRow("a", { text: "edited" }), idRow("b"), idRow("d")];

        shard.outcomes.set("messages:list", { result: nextResult, tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        const deltas = ws.sent
            .slice(sentBefore)
            .map((line) => JSON.parse(line) as { delta: MutationDelta; type: string })
            .filter((frame) => frame.type === "delta")
            .map((frame) => frame.delta);

        // Apply each delta the same way the client's applyDelta does.
        let merged = baseline;

        for (const delta of deltas) {
            if (delta.op === "delete") {
                merged = merged.filter((entry) => entry["_id"] !== delta.key);
            } else {
                const index = merged.findIndex((entry) => entry["_id"] === delta.key);

                merged = index === -1 ? [...merged, delta.row!] : merged.map((entry, position) => (position === index ? delta.row! : entry));
            }
        }

        expect(merged).toEqual(nextResult);
    });

    // -------------------------------------------------------------------------
    // Finding #6 — the pushed `{type:"delta"}` frame strings must be byte-for-byte
    // identical to the legacy `JSON.stringify(delta)`-based encoding, even though
    // the production path now reuses the diff's per-row fingerprint instead of
    // re-serializing the delta. Reconstruct the expected wire strings from the
    // returned deltas and assert exact string equality (not just structural).
    // -------------------------------------------------------------------------
    it("pushed delta frame strings are byte-identical to the JSON.stringify(delta) encoding", async () => {
        expect.assertions(2);

        const shard = new ReexecShard(state, {});
        const ws = createFakeWebSocket();

        shard.registerSocket(ws);

        const prevResult = [idRow("a", { text: "old" }), idRow("b"), idRow("c")];

        shard.outcomes.set("messages:list", { result: prevResult, tables: new Set(["messages"]) });
        await subscribeMessages(shard, ws);

        const sentBefore = ws.sent.length;

        // delete c, update a, insert d — all three delta branches in one refresh,
        // 3 deltas for a length-3 next result (under the chattiness cap).
        const nextResult = [idRow("a", { text: "new" }), idRow("b"), idRow("d", { text: "hi" })];

        shard.outcomes.set("messages:list", { result: nextResult, tables: new Set(["messages"]) });
        shard.changedTableOnRpc = "messages";
        await shard.writeRpc();

        const sentDeltaLines = ws.sent.slice(sentBefore).filter((line) => (JSON.parse(line) as { type: string }).type === "delta");

        // Derive the expected wire strings directly from subscriptionListDeltas,
        // encoding each delta the legacy way (JSON.stringify(delta)).
        const expectedDeltas = subscriptionListDeltas(JSON.stringify(prevResult), nextResult, "messages");
        const expectedLines = (expectedDeltas ?? []).map((delta) => `{"type":"delta","id":"sub-1","delta":${JSON.stringify(delta)}}`);

        expect(sentDeltaLines).toHaveLength(expectedLines.length);
        expect(sentDeltaLines).toEqual(expectedLines);
    });
});
