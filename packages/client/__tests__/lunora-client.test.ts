import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeWire, encodeWire } from "../../../shared/wire-codec";
import { createClientQuery } from "../src/client-query-store";
import { isConflictError } from "../src/errors";
import type { OptimisticUpdate } from "../src/local-store";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createInMemoryQueryCache, queryCacheKey } from "../src/query-cache";
import type { CachedQuery, FunctionReference, QueryCacheAdapter } from "../src/types";

const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

// --- Test doubles -----------------------------------------------------------

interface MockSocket {
    addEventListener: (type: string, listener: (event?: unknown) => void) => void;
    close: () => void;
    onclose?: ((event?: unknown) => void) | null;
    onerror?: ((event?: unknown) => void) | null;
    onmessage?: ((event: { data: unknown }) => void) | null;
    onopen?: ((event?: unknown) => void) | null;
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    send: (data: string) => void;
    sent: string[];
    triggerClose: () => void;
    /** Fire a bare `error` event with no follow-up `close` — some WS implementations do this. */
    triggerError: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

/**
 * A browser dispatches `close` on a LATER turn, never synchronously inside
 * `close()`. Modelling that faithfully is not optional: `teardownConnection`
 * clears `conn.socket` AFTER calling `close()`, so a same-tick close still
 * finds the identity guard satisfied and reaches `handleDisconnect` — which
 * hides the whole class of teardown-ordering bug from every test using it.
 */
const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

        public onopen: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }

        public triggerError(): void {
            this.onerror?.();
            this.dispatch("error");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            // Faithful to the browser: `readyState` flips synchronously, but the
            // `close` EVENT lands on a later turn. Dispatching it synchronously
            // hides teardown-ordering bugs, because `teardownConnection` clears
            // `conn.socket` AFTER calling `close()` — a same-tick event still
            // finds the identity guard satisfied and reaches `handleDisconnect`.
            this.readyState = 3;

            setTimeout(() => {
                this.triggerClose();
            }, 0);
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const latestSocket = (): MockSocket => {
    const last = sockets.at(-1);

    if (!last) {
        throw new Error("no socket has been created yet");
    }

    return last;
};

/**
 * The JSON control frames a socket sent, excluding the always-first `connect`
 * lifecycle envelope (the client announces every socket on open so `onConnect`
 * fires symmetrically with `onDisconnect`) and the raw `lunora-ping` keepalive
 * strings. Tests assert on the subscribe/unsubscribe traffic, which the leading
 * connect frame would otherwise shift off index 0.
 */
const wireFrames = (socket: MockSocket) =>
    socket.sent
        .filter((frame) => frame !== "lunora-ping")
        .map((frame) => JSON.parse(frame))
        .filter((frame) => frame.type !== "connect");

/** The first subscribe/unsubscribe frame a socket sent, past the connect envelope. */
const firstSub = (socket: MockSocket) => wireFrames(socket)[0];

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 200,
        ...init,
    });

describe("lunoraClient", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    // --- RPC --------------------------------------------------------------------

    describe("lunoraClient — queries & mutations", () => {
        it("query roundtrips through POST /_lunora/rpc and unwraps the result", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { hello: "world" } }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const value = await client.query(fnRef("posts:list"), { limit: 10 });

            expect(value).toEqual({ hello: "world" });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/rpc");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({
                args: { limit: 10 },
                functionPath: "posts:list",
                shardKey: undefined,
            });
        });

        it("query surfaces server errors as thrown Error objects", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.query(fnRef("posts:get"), { id: "abc" })).rejects.toMatchObject({
                code: "NOT_FOUND",
                message: "missing",
            });
        });

        it("mutation conflict (409) carries the CONFLICT code so isConflictError matches", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () =>
                jsonResponse({ error: { code: "CONFLICT", message: "optimistic concurrency conflict" } }, { status: 409 }),
            );

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const error = await client.mutation(fnRef("posts:update"), { id: "abc", title: "x" }).then(
                () => {
                    throw new Error("mutation should have rejected with a conflict");
                },
                (error_: unknown) => error_,
            );

            expect(isConflictError(error)).toBe(true);
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe("optimistic concurrency conflict");
        });

        it("query conflict (409) carries the CONFLICT code so isConflictError matches", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () =>
                jsonResponse({ error: { code: "CONFLICT", message: "optimistic concurrency conflict" } }, { status: 409 }),
            );

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const error = await client.query(fnRef("posts:get"), { id: "abc" }).then(
                () => {
                    throw new Error("query should have rejected with a conflict");
                },
                (error_: unknown) => error_,
            );

            expect(isConflictError(error)).toBe(true);
            expect((error as Error).message).toBe("optimistic concurrency conflict");
        });

        it("a non-CONFLICT coded error does not satisfy isConflictError", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "NOT_FOUND", message: "missing" } }, { status: 404 }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const error = await client.query(fnRef("posts:get"), { id: "abc" }).then(
                () => {
                    throw new Error("query should have rejected");
                },
                (error_: unknown) => error_,
            );

            expect(isConflictError(error)).toBe(false);
        });

        it("mutation captures x-d1-bookmark and replays it on the next query", async () => {
            expect.assertions(1);

            let call = 0;

            const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (_url: string, init: RequestInit) => {
                call += 1;

                if (call === 1) {
                    return Response.json(
                        { result: { ok: true } },
                        {
                            headers: {
                                "content-type": "application/json",
                                "x-d1-bookmark": "bm-123",
                            },
                            status: 200,
                        },
                    );
                }

                // capture headers on the second (query) call
                (fetchMock as unknown as { lastHeaders?: Record<string, string> }).lastHeaders = (init.headers ?? {}) as Record<string, string>;

                return jsonResponse({ result: { rows: [] } });
            });

            const client = new LunoraClient({
                fetch: fetchMock as unknown as typeof fetch,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.mutation(fnRef("posts:create"), { title: "hi" });
            await client.query(fnRef("posts:list"), {});

            const headers = (fetchMock as unknown as { lastHeaders: Record<string, string> }).lastHeaders;

            expect(headers["x-d1-bookmark"]).toBe("bm-123");
        });

        it("action captures x-d1-bookmark and replays it on the next query", async () => {
            expect.assertions(1);

            // An action is the one entry point that both reads (`ctx.runQuery`)
            // and writes (`ctx.runMutation`). It passed neither bookmark flag, so
            // an action writing through a `.global()` / D1 table left the bookmark
            // untouched and the next query could be answered by a replica that
            // predated the write.
            let call = 0;
            let queryHeaders: Record<string, string> = {};

            const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (_url: string, init: RequestInit) => {
                call += 1;

                if (call === 1) {
                    return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json", "x-d1-bookmark": "bm-act" }, status: 200 });
                }

                queryHeaders = (init.headers ?? {}) as Record<string, string>;

                return jsonResponse({ result: { rows: [] } });
            });

            const client = new LunoraClient({
                fetch: fetchMock as unknown as typeof fetch,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.action(fnRef("posts:sync"), {});
            await client.query(fnRef("posts:list"), {});

            expect(queryHeaders["x-d1-bookmark"]).toBe("bm-act");
        });

        it("authorization header is attached when token is set", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("tkn");
            await client.query(fnRef("any:thing"), {});

            const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
            const headers = init.headers as Record<string, string>;

            expect(headers.authorization).toBe("Bearer tkn");
            expect(client.getAuthToken()).toBe("tkn");
        });
    });

    // --- Custom-mutator watermark ----------------------------------------------

    describe("lunoraClient — callMutator watermark", () => {
        it("sends the client id + seq and reports applied when the DO runs the push as next", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 1, result: "ok" }));

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const ack = await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 1, shardKey: "room-1" });

            expect(ack).toStrictEqual({ applied: true, result: "ok" });
            expect(client.confirmedMutationWatermark("room-1")).toBe(1);

            const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;

            expect(headers["x-lunora-client-id"]).toBe("client-A");
            expect(headers["x-lunora-client-seq"]).toBe("1");
        });

        it("pairs `x-lunora-client-id` with every `x-lunora-mutation-id` (anonymous dedup namespace)", async () => {
            expect.assertions(2);

            // The shard keys an ANONYMOUS caller's `__idempotency` row by the client
            // id. A mutation id sent without one has no namespace, so the DO skips
            // the dedup cache entirely and a replayed write re-runs — the header
            // pair is what keeps exactly-once working for a signed-out caller.
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: "ok" }));

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.mutation(fnRef("posts:create"), { title: "a" }, { mutationId: "m-1" });

            const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;

            expect(headers["x-lunora-mutation-id"]).toBe("m-1");
            expect(headers["x-lunora-client-id"]).toBe("client-A");
        });

        it("reports applied=false and surfaces the echoed watermark when the DO swallows a stale push as a replay", async () => {
            expect.assertions(2);

            // The server's replay ack echoes its (higher) stored watermark with a
            // null result — clientSeq 1 was already applied in a prior session.
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 5, result: null }));

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const ack = await client.callMutator("messages:send", { text: "hi" }, { clientSeq: 1, shardKey: "room-1" });

            expect(ack).toStrictEqual({ applied: false, result: null });
            // The client now knows the real watermark, so the next seq can clear it.
            expect(client.confirmedMutationWatermark("room-1")).toBe(5);
        });

        it("omits the seq header when no clientSeq is given so the push rides the idempotency path", async () => {
            expect.assertions(3);

            // No `lastMutationId` echo — a non-watermarked call the DO ran once.
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: "ok" }));

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // No `clientSeq` — must NOT default to 0 (a seq of 0 is `<=` the initial
            // watermark, which the DO would swallow as a replay without running it).
            const ack = await client.callMutator("messages:send", { text: "hi" });

            expect(ack).toStrictEqual({ applied: true, result: "ok" });

            const headers = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>;

            expect(headers["x-lunora-client-id"]).toBe("client-A");
            expect(headers["x-lunora-client-seq"]).toBeUndefined();
        });

        it("tracks the watermark per shard bucket", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 3, result: null }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.callMutator("messages:send", {}, { clientSeq: 3, shardKey: "room-1" });

            expect(client.confirmedMutationWatermark("room-1")).toBe(3);
            // A different shard keeps its own watermark (untouched).
            expect(client.confirmedMutationWatermark("room-2")).toBe(0);
        });
    });

    // --- Subscriptions ----------------------------------------------------------

    describe("lunoraClient — subscriptions", () => {
        it("subscribe sends a subscribe envelope and delivers delta payloads", async () => {
            expect.assertions(5);

            const fetchMock = vi.fn<typeof fetch>();
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];
            const unsubscribe = client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            expect(wireFrames(socket)).toHaveLength(1);

            const sub = firstSub(socket);

            expect(sub.type).toBe("subscribe");
            expect(sub.id).toMatch(/^sub_/);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ delta: { count: 1 }, id: sub.id, type: "delta" });
            socket.receive({ data: { count: 2 }, id: sub.id, type: "data" });

            expect(received).toEqual([{ count: 1 }, { count: 2 }]);

            unsubscribe();

            const last = JSON.parse(socket.sent.at(-1)!);

            expect(last).toEqual({ id: sub.id, type: "unsubscribe" });
        });

        it("wire-encodes bigint/Date subscription args on the subscribe frame (and dedups/distinguishes by value)", async () => {
            expect.assertions(6);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Pre-change this threw at the registry key; now it must key, send,
            // and JSON-serialize cleanly (the raw frame stringify would throw on
            // a real bigint).
            client.subscribe(fnRef("messages:list"), { at: new Date(5000), since: 123n }, () => {});

            const socket = latestSocket();

            socket.open();

            expect(wireFrames(socket)).toHaveLength(1);

            const sub = firstSub(socket);

            expect(sub.type).toBe("subscribe");
            // The frame carries the TAGGED wire form; the shard's decode-at-entry
            // revives the real values before storing/executing.
            expect(decodeWire(sub.query.args)).toStrictEqual({ at: new Date(5000), since: 123n });

            socket.receive({ id: sub.id, type: "ack" });

            // Same wire-typed args → deduped onto the existing (acked) registration…
            client.subscribe(fnRef("messages:list"), { at: new Date(5000), since: 123n }, () => {});

            expect(wireFrames(socket)).toHaveLength(1);

            // …while args differing ONLY by the bigint open a distinct subscription.
            client.subscribe(fnRef("messages:list"), { at: new Date(5000), since: 124n }, () => {});

            expect(wireFrames(socket)).toHaveLength(2);
            expect(wireFrames(socket)[1].id).not.toBe(sub.id);

            client.close();
        });

        it("keeps pure-JSON subscribe frames byte-identical (no wire tags)", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), { channel: "general", limit: 10 }, () => {});

            const socket = latestSocket();

            socket.open();

            expect(firstSub(socket).query.args).toStrictEqual({ channel: "general", limit: 10 });

            client.close();
        });

        it("rejects a subscription arg the wire refuses with a TypeError at the call site", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            expect(() => client.subscribe(fnRef("messages:list"), { pattern: /abc/ }, () => {})).toThrow(TypeError);

            client.close();
        });

        it("forwards a settled frame's watermark to onCheckpoint without firing the data callback", () => {
            expect.assertions(3);

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];
            const checkpoints: { checkpoint?: number; mutationId?: number }[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d), {
                onCheckpoint: (watermark) => checkpoints.push(watermark),
            });

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            // A write touched the read tables but the result was byte-identical, so
            // the server sent a `settled` frame instead of a data frame.
            socket.receive({ cursor: 12, epoch: "e1", id: sub.id, lastMutationId: 5, type: "settled" });

            // No value changed — the data callback must not fire...
            expect(received).toEqual([]);
            // ...but the echoed watermark + advanced cursor reach onCheckpoint so a
            // @lunora/db list overlay can drop.
            expect(checkpoints).toEqual([{ checkpoint: 12, mutationId: 5 }]);

            // An older client (or one with no settled support) safely ignores an
            // unknown frame — the default switch arm is a no-op.
            expect(() => {
                socket.receive({ id: sub.id, type: "totally-unknown-frame" });
            }).not.toThrow();

            client.close();
        });

        it("forwards a data frame's lastMutationId to onCheckpoint, monotonically, alongside the data callback (plan 266 S4)", () => {
            expect.assertions(3);

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];
            const checkpoints: { checkpoint?: number; mutationId?: number }[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d), {
                onCheckpoint: (watermark) => checkpoints.push(watermark),
            });

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            // The server now stamps the client's per-mutator watermark on a plain
            // `data` frame too (not just `settled`) — the frame the client can
            // trust as reflecting what THESE rows actually confirm.
            socket.receive({ cursor: 10, data: [{ _id: "m1" }], epoch: "e1", id: sub.id, lastMutationId: 5, type: "data" });

            // The value changed, so the data callback fires...
            expect(received).toEqual([[{ _id: "m1" }]]);
            // ...and the frame's own watermark ALSO reaches onCheckpoint, same
            // tail as a `settled` frame — but stamped `rowsFollow`, which a
            // rowless `settled` frame is not. That flag is what lets `@lunora/db`
            // stash the watermark for the rowset landing right behind it, without
            // a settled frame's watermark going stale in the same slot.
            expect(checkpoints).toEqual([{ checkpoint: 10, mutationId: 5, rowsFollow: true }]);

            // A later frame with a LOWER watermark must never move it backwards.
            socket.receive({ cursor: 11, data: [{ _id: "m2" }], epoch: "e1", id: sub.id, lastMutationId: 3, type: "data" });

            expect(checkpoints.at(-1)).toStrictEqual({ checkpoint: 11, mutationId: 5, rowsFollow: true });

            client.close();
        });

        it("ignores a settled frame for an unknown subscription id", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            expect(() => {
                socket.receive({ cursor: 1, id: "sub_does_not_exist", type: "settled" });
            }).not.toThrow();

            client.close();
        });

        it("fans a settled frame out to every subscriber sharing the same subscription state", () => {
            // Regression: SubscriptionState is shared across subscribers to the same
            // (fn, args, shardKey). A second subscriber (e.g. a @lunora/db collection)
            // that joins AFTER a plain useQuery must still receive `settled` fan-out —
            // a single onCheckpoint slot would only ever notify the state's creator.
            expect.assertions(2);

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const first: { checkpoint?: number; mutationId?: number }[] = [];
            const second: { checkpoint?: number; mutationId?: number }[] = [];

            // First subscriber CREATES the shared state...
            client.subscribe(fnRef("messages:list"), {}, () => undefined, {
                onCheckpoint: (watermark) => first.push(watermark),
            });
            // ...second subscriber JOINS the existing state (same fn + args).
            client.subscribe(fnRef("messages:list"), {}, () => undefined, {
                onCheckpoint: (watermark) => second.push(watermark),
            });

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ cursor: 7, epoch: "e1", id: sub.id, lastMutationId: 3, type: "settled" });

            // BOTH checkpoint callbacks fire, not just the creator's.
            expect(first).toEqual([{ checkpoint: 7, mutationId: 3 }]);
            expect(second).toEqual([{ checkpoint: 7, mutationId: 3 }]);

            client.close();
        });

        it("announces every socket with a context-less connect envelope before resubscribing", () => {
            expect.assertions(3);

            const client = new LunoraClient({
                clientId: "client-A",
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // No connection context registered: the socket must still announce
            // itself so the server's `onConnect` hooks fire symmetrically with
            // `onDisconnect`. The envelope carries the `clientId` (so pokes can
            // echo this client's `lastMutationId`) but no `context`.
            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const connect = JSON.parse(socket.sent[0]!);

            expect(connect).toEqual({ caps: ["pageDelta"], clientId: "client-A", id: "connect", type: "connect" });
            // The connect frame leads, then the subscribe — order matters so the
            // hook runs with any context in place before subscriptions replay.
            expect(JSON.parse(socket.sent[1]!).type).toBe("subscribe");
            expect(connect.context).toBeUndefined();

            client.close();
        });

        it("carries the registered connection context on the connect envelope", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                clientId: "client-A",
                connectionContext: { roomId: "room-1" },
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            expect(JSON.parse(socket.sent[0]!)).toEqual({
                caps: ["pageDelta"],
                clientId: "client-A",
                context: { roomId: "room-1" },
                id: "connect",
                type: "connect",
            });

            client.close();
        });

        it("refcounts acquireConnectionContext: retained until the last holder releases", () => {
            expect.assertions(4);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            // The latest `connect` frame on the wire (each acquire/release while
            // the socket is open re-announces the effective context).
            const latestContext = (): unknown => {
                const connects = socket.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "connect");

                return connects.at(-1)?.context;
            };

            // Two holders on the same (default) shard — e.g. two mounted
            // `usePresence` hooks. The most-recent acquire wins.
            const releaseA = client.acquireConnectionContext({ holder: "a" });
            const releaseB = client.acquireConnectionContext({ holder: "b" });

            expect(latestContext()).toEqual({ holder: "b" });

            // Releasing the top holder falls back to the previous one rather than
            // clearing — the bug was a second hook's cleanup stomping the first.
            releaseB();

            expect(latestContext()).toEqual({ holder: "a" });

            // Double release is a no-op (holder matched by reference).
            releaseB();

            expect(latestContext()).toEqual({ holder: "a" });

            // Only when the last holder releases is the context cleared.
            releaseA();

            expect(latestContext()).toBeUndefined();

            client.close();
        });

        it("sends keepalive pings on an open socket and stops them on disconnect", () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                heartbeatIntervalMs: 1000,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            // Only the subscribe envelope counts here (the connect frame is filtered out); no ping has fired yet.
            expect(wireFrames(socket)).toHaveLength(1);

            vi.advanceTimersByTime(1000);

            expect(socket.sent.at(-1)).toBe("lunora-ping");

            vi.advanceTimersByTime(1000);

            expect(socket.sent.filter((f) => f === "lunora-ping")).toHaveLength(2);

            // After the socket drops, the heartbeat must stop (no leaked interval).
            socket.triggerClose();
            vi.advanceTimersByTime(5000);

            expect(socket.sent.filter((f) => f === "lunora-ping")).toHaveLength(2);

            client.close();
        });

        it("force-closes a half-open socket once no frame has arrived for heartbeatIntervalMs * 2.5, and arms reconnect (CLIENT-02)", () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                heartbeatIntervalMs: 1000,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            expect(client.connectionStatus()).toBe("connected");

            // Two heartbeat ticks pass with no reply at all (not even a pong) —
            // still under the 2.5x window (2500ms), so the socket stays open and
            // a ping keeps going out each tick.
            vi.advanceTimersByTime(2000);

            expect(socket.readyState).toBe(1);

            // The third tick crosses `heartbeatIntervalMs * 2.5`: the far end has
            // gone quiet without the socket ever firing `close` (a half-open
            // socket — a swallowed RST, a stuck proxy) — the watchdog force-closes
            // it instead of leaving it reporting "open" forever while every live
            // query on it silently stales, and the normal reconnect/backoff arms.
            vi.advanceTimersByTime(1000);

            expect(socket.readyState).toBe(3);
            expect(client.connectionStatus()).toBe("offline");

            client.close();
        });

        it("a socket that keeps receiving ANY frame (even the non-JSON lunora-pong) is never force-closed by the watchdog (CLIENT-02)", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                heartbeatIntervalMs: 1000,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            // The server answers every ping with `lunora-pong` — a plain,
            // non-JSON string the `handleServerMessage` JSON.parse guard drops —
            // but it must still reset the watchdog (it proves the socket is
            // alive). Five ticks span 5000ms, well past the 2500ms window, so a
            // watchdog that ignored the pong would have force-closed by now.
            for (let tick = 0; tick < 5; tick += 1) {
                vi.advanceTimersByTime(1000);
                socket.receive("lunora-pong");
            }

            expect(socket.readyState).toBe(1);
            expect(client.connectionStatus()).toBe("connected");

            client.close();
        });

        it("does not send keepalive pings when the heartbeat is disabled", () => {
            expect.assertions(1);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                heartbeatIntervalMs: 0,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();
            vi.advanceTimersByTime(60_000);

            expect(socket.sent).not.toContain("lunora-ping");

            client.close();
        });

        it("force-closes a stuck-connecting socket after the connect timeout and goes offline", () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                connectTimeoutMs: 5000,
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            // Handshake hangs: the socket never fires `open`, so it sits connecting.
            expect(client.connectionStatus()).toBe("connecting");

            // Just before the timeout, nothing has changed.
            vi.advanceTimersByTime(4999);

            expect(socket.readyState).not.toBe(3);

            // At the timeout, the client force-closes the stuck socket and falls
            // back to its reconnect path (status `offline`), instead of hanging on
            // the browser's much longer default.
            vi.advanceTimersByTime(1);

            expect(socket.readyState).toBe(3);
            expect(client.connectionStatus()).toBe("offline");

            client.close();
        });

        it("clears the connect timeout once the socket opens (no spurious close)", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                connectTimeoutMs: 5000,
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            expect(client.connectionStatus()).toBe("connected");

            // Well past the timeout window: an open socket must not be force-closed.
            vi.advanceTimersByTime(10_000);

            expect(socket.readyState).toBe(1);

            client.close();
        });

        it("ignores a late close from a socket the connection already replaced", () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                // Fixed, jitter-free backoff so a single timer advance fires exactly
                // one reconnect; no connect timeout so `fresh` arms no competing timer.
                reconnect: { initialDelayMs: 1000, jitter: false },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const stale = latestSocket();

            stale.open();

            expect(client.connectionStatus()).toBe("connected");

            // The socket drops; the client arms its reconnect and, on the timer,
            // builds a fresh socket that's now the connection's current one.
            stale.triggerClose();
            vi.advanceTimersByTime(1000);

            const fresh = latestSocket();

            expect(fresh).not.toBe(stale);

            // A late, duplicate close from the dead socket must NOT tear down the
            // newer one (the close handler is guarded by `conn.socket === socket`):
            // the connection stays `connecting` on `fresh`, then opens normally.
            stale.triggerClose();

            expect(client.connectionStatus()).toBe("connecting");

            fresh.open();

            expect(client.connectionStatus()).toBe("connected");

            client.close();
        });

        it("resets the reconnect backoff on a socket that stays open but receives no JSON frame", () => {
            expect.assertions(3);

            vi.useFakeTimers();
            sockets.length = 0;

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 1000, jitter: false },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.subscribe(fnRef("messages:list"), {}, () => undefined);
                latestSocket().open();

                // First drop: one initial-delay reconnect.
                latestSocket().triggerClose();
                vi.advanceTimersByTime(1000);

                expect(sockets).toHaveLength(2);

                // This socket is accepted but the server sends nothing — no ack for
                // `connect`, and the keepalive pong is a plain string the JSON parse
                // rejects. Staying open past the stability window is the only proof
                // of acceptance it will ever have.
                latestSocket().open();
                vi.advanceTimersByTime(5000);
                latestSocket().triggerClose();

                // Backoff was reset, so this drop reconnects at the INITIAL delay
                // again. Without the reset it had doubled to 2000ms and nothing
                // would appear yet — every blip compounding to the 30s cap on a
                // connection that was healthy throughout.
                vi.advanceTimersByTime(1000);

                expect(sockets).toHaveLength(3);

                // A socket that does NOT survive the window earns no reset: the
                // credential-rejection storm this backoff exists to damp closes
                // well inside it.
                latestSocket().open();
                vi.advanceTimersByTime(100);
                latestSocket().triggerClose();
                vi.advanceTimersByTime(1000);

                expect(sockets).toHaveLength(3);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        });

        it("keys reactive page subscriptions by their (lower, upper] cursor range", () => {
            expect.assertions(3);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Two adjacent reactive pages over the same feed differ only by their
            // paginationOpts range — (null, C1] vs (C1, C2]. Each must open its
            // own subscription so a delta lands on exactly one page.
            client.subscribe(fnRef("messages:list"), { paginationOpts: { cursor: null, endCursor: "C1", numItems: 5 } }, () => undefined);
            client.subscribe(fnRef("messages:list"), { paginationOpts: { cursor: "C1", endCursor: "C2", numItems: 5 } }, () => undefined);

            const socket = latestSocket();

            socket.open();

            // Distinct ranges ⇒ two distinct subscribe envelopes with distinct ids.
            expect(wireFrames(socket)).toHaveLength(2);

            const sentIds = wireFrames(socket).map((frame) => frame.id);

            expect(new Set(sentIds).size).toBe(2);

            // Ack both so the registry dedup guard (acked) engages, then
            // re-subscribe the exact same first-page range: it reuses the
            // existing subscription id rather than opening a third.
            for (const id of sentIds) {
                socket.receive({ id, type: "ack" });
            }

            client.subscribe(fnRef("messages:list"), { paginationOpts: { cursor: null, endCursor: "C1", numItems: 5 } }, () => undefined);

            expect(wireFrames(socket)).toHaveLength(2);
        });

        it("appends wsToken to the WebSocket URL so the upgrade can authorize it", () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "admin tok/en",
            });

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined);

            const { url } = latestSocket();

            expect(url).toContain("token=admin%20tok%2Fen");
            // The default WS path is still present alongside the token parameter.
            expect(url).toContain("/_lunora/ws");
        });

        it("surfaces a server subscription error to the onError callback", () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const errors: { message: string }[] = [];
            const data: unknown[] = [];

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, (d) => data.push(d), { onError: (error) => errors.push(error) });

            const socket = latestSocket();

            socket.open();
            socket.receive({ id: firstSub(socket).id, message: "admin subscription requires admin authorization", type: "error" });

            expect(errors).toEqual([{ message: "admin subscription requires admin authorization" }]);
            expect(data).toHaveLength(0);
        });

        it("surfaces the code and nested message from a subscription error envelope", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const errors: { code?: string; message: string }[] = [];

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined, { onError: (error) => errors.push(error) });

            const socket = latestSocket();

            socket.open();
            // The server sent the rejection only via the nested `error` envelope
            // (no top-level `message`): both the code and the message must survive.
            socket.receive({ error: { code: "ADMIN_FORBIDDEN", message: "admin gate not cleared" }, id: firstSub(socket).id, type: "error" });

            expect(errors).toEqual([{ code: "ADMIN_FORBIDDEN", message: "admin gate not cleared" }]);
        });

        it("a complete frame for a live subscription surfaces SUBSCRIPTION_CANCELLED and re-subscribes on the next reconnect instead of freezing (CLIENT-04)", () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const errors: { code?: string; message: string }[] = [];
            const data: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => data.push(d), { onError: (error) => errors.push(error) });

            const first = latestSocket();

            first.open();

            const subId = firstSub(first).id as string;

            // A subscription-scoped `complete` frame — today's server only sends
            // `complete` for stream ids (see the source comment on
            // `handleCompleteMessage`), but this pins the defensive behavior for
            // a `sub_*` id in case a future/subclassed `ShardDO` ever cancels a
            // subscription this way. The historical behavior removed the state
            // from the registry entirely, so it never resubscribed on ANY future
            // reconnect and the query froze forever.
            first.receive({ id: subId, type: "complete" });

            expect(errors).toEqual([{ code: "SUBSCRIPTION_CANCELLED", message: "subscription was cancelled by the server" }]);

            // The socket drops and reconnects.
            first.triggerClose();
            vi.advanceTimersByTime(15);

            const second = latestSocket();

            second.open();

            // Non-destructive: the subscription is still registered and gets
            // re-sent on the fresh socket instead of having silently vanished.
            expect(second).not.toBe(first);
            expect(firstSub(second)?.query?.functionPath).toBe("messages:list");
            expect(data).toHaveLength(0);

            client.close();
            vi.useRealTimers();
        });

        it("re-sends an admin subscription with its token on reconnect", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            vi.advanceTimersByTime(15);

            const second = latestSocket();

            second.open();

            // The fresh socket carries the token again, so the server re-stamps the
            // admin flag and the re-sent subscribe clears the admin gate.
            expect(second).not.toBe(first);
            expect(second.url).toContain("token=adm1n");
            expect(firstSub(second).query.functionPath).toBe("__lunora_admin__:getMetrics");

            client.close();
            vi.useRealTimers();
        });

        it("on reconnect, all active subscriptions are re-sent", async () => {
            expect.assertions(6);

            vi.useFakeTimers();
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("a:b"), { x: 1 }, () => undefined);
            const first = latestSocket();

            first.open();

            expect(wireFrames(first)).toHaveLength(1);

            first.triggerClose();

            expect(sockets).toHaveLength(1);

            vi.advanceTimersByTime(15);
            const second = latestSocket();

            expect(second).not.toBe(first);

            second.open();

            expect(wireFrames(second)).toHaveLength(1);

            const env = firstSub(second);

            expect(env.type).toBe("subscribe");
            expect(env.query.args).toEqual({ x: 1 });

            client.close();
        });

        it("duplicate subscribe calls share a single server-side subscription", () => {
            expect.assertions(5);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const aReceived: unknown[] = [];
            const bReceived: unknown[] = [];

            const unsubA = client.subscribe(fnRef("rooms:list"), { roomId: "r1" }, (d) => aReceived.push(d));
            const unsubB = client.subscribe(fnRef("rooms:list"), { roomId: "r1" }, (d) => bReceived.push(d));

            const socket = latestSocket();

            socket.open();

            // Only one subscribe envelope despite two consumers.
            const subs = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "subscribe");

            expect(subs).toHaveLength(1);

            socket.receive({ delta: { v: 42 }, id: subs[0].id, type: "delta" });

            expect(aReceived).toEqual([{ v: 42 }]);
            expect(bReceived).toEqual([{ v: 42 }]);

            unsubA();

            // Still subscribed since B is listening.
            expect(socket.sent.filter((s) => JSON.parse(s).type === "unsubscribe")).toHaveLength(0);

            unsubB();

            // Now an unsubscribe should fire.
            expect(socket.sent.filter((s) => JSON.parse(s).type === "unsubscribe")).toHaveLength(1);
        });

        it("merges structured row deltas into the cached list incrementally", () => {
            expect.assertions(4);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });

            // Initial snapshot seeds the cached list.
            socket.receive({ data: [{ _id: "a", text: "one" }], id: sub.id, type: "data" });
            // Structured insert delta is merged (appended), not replaced.
            socket.receive({ delta: { key: "b", op: "insert", row: { _id: "b", text: "two" }, table: "messages" }, id: sub.id, type: "delta" });
            // Update in place, position preserved.
            socket.receive({ delta: { key: "a", op: "update", row: { _id: "a", text: "ONE" }, table: "messages" }, id: sub.id, type: "delta" });
            // Delete removes only the matching row.
            socket.receive({ delta: { key: "a", op: "delete", table: "messages" }, id: sub.id, type: "delta" });

            expect(received[0]).toStrictEqual([{ _id: "a", text: "one" }]);
            expect(received[1]).toStrictEqual([
                { _id: "a", text: "one" },
                { _id: "b", text: "two" },
            ]);
            expect(received[2]).toStrictEqual([
                { _id: "a", text: "ONE" },
                { _id: "b", text: "two" },
            ]);
            expect(received[3]).toStrictEqual([{ _id: "b", text: "two" }]);
        });

        it("a full data snapshot replaces the cached list wholesale", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ data: [{ _id: "a" }, { _id: "b" }], id: sub.id, type: "data" });
            socket.receive({ delta: { key: "c", op: "insert", row: { _id: "c" }, table: "messages" }, id: sub.id, type: "delta" });
            // A fresh snapshot wins outright, discarding the merged state.
            socket.receive({ data: [{ _id: "z" }], id: sub.id, type: "data" });

            expect(received.at(-1)).toStrictEqual([{ _id: "z" }]);
        });

        it("holds the resume cursor until the last frame of a delta run arrives", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            // The other half of the server-side contract pinned in
            // `@lunora/shard-engine`'s subscription-frames suite: a delta run has
            // no `pokeStart`/`pokeEnd` envelope, so the cursor rides only its last
            // frame. A socket that dies mid-run must therefore leave the client
            // resuming from BEFORE the run, or the server answers its `sinceSeq`
            // with "already current" and the half-applied list is never re-sent.
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const first = latestSocket();

            first.open();

            const subId = firstSub(first).id as string;

            first.receive({ cursor: 10, data: [{ _id: "a" }, { _id: "b" }, { _id: "c" }], id: subId, type: "data" });
            // Frame 1 of a 3-frame run; the socket dies before frames 2 and 3.
            first.receive({ delta: { key: "a", op: "delete", table: "messages" }, id: subId, type: "delta" });

            expect(received.at(-1)).toStrictEqual([{ _id: "b" }, { _id: "c" }]);

            first.triggerClose();
            vi.advanceTimersByTime(15);

            const second = latestSocket();

            second.open();

            const resumed = firstSub(second) as { query: { sinceSeq?: number } };

            expect(resumed.query.sinceSeq).toBe(10);

            // …and the last frame of a completed run does move it.
            second.receive({ cursor: 13, delta: { key: "b", op: "delete", table: "messages" }, id: subId, type: "delta" });
            second.triggerClose();
            vi.advanceTimersByTime(15);

            const third = latestSocket();

            third.open();

            expect((firstSub(third) as { query: { sinceSeq?: number } }).query.sinceSeq).toBe(13);

            client.close();
            vi.useRealTimers();
        });

        it("does not replay a resume cursor it holds no value behind", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            // A checkpoint can get ahead of the value: a cross-tab FOLLOWER's
            // `settled` broadcast advances its cursor even though the leader's
            // `data` frames landed before it joined. The frame handler below
            // reaches the same state directly. Replaying that cursor as
            // `sinceSeq` gets a bare `resume` back — no data — so the
            // subscription would hang empty forever.
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const first = latestSocket();

            first.open();

            const subId = firstSub(first).id as string;

            // Cursor advances with NO value behind it.
            first.receive({ cursor: 10, epoch: "e1", id: subId, type: "settled" });
            first.triggerClose();
            vi.advanceTimersByTime(15);

            const second = latestSocket();

            second.open();

            const resubscribe = firstSub(second) as { query: { sinceEpoch?: string; sinceSeq?: number } };

            expect(resubscribe.query.sinceSeq).toBeUndefined();
            expect(resubscribe.query.sinceEpoch).toBeUndefined();

            // With a value behind it the cursor IS replayed — the guard is about
            // the missing value, not about distrusting `settled`.
            second.receive({ cursor: 11, data: [], id: subId, type: "data" });
            second.triggerClose();
            vi.advanceTimersByTime(15);

            const third = latestSocket();

            third.open();

            expect((firstSub(third) as { query: { sinceSeq?: number } }).query.sinceSeq).toBe(11);

            client.close();
            vi.useRealTimers();
        });

        it("publishes a delta that arrives with no cached base instead of re-subscribing", () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });

            // No `data` frame first, and no `cursor` on the delta — this is the
            // legacy `ShardDO.broadcastDelta` fan-out, which stamps neither. An
            // absent base is NOT a merge failure: there is nothing to merge into
            // and nothing to corrupt, and because no cursor moves, publishing the
            // change strands nothing. Treating it as unmergeable would turn every
            // broadcast to an unseeded subscriber into a re-subscribe.
            socket.receive({ delta: { key: "m-1", op: "insert", row: { id: "m-1", text: "hi" }, table: "messages:list" }, id: sub.id, type: "delta" });

            expect(received).toStrictEqual([{ key: "m-1", op: "insert", row: { id: "m-1", text: "hi" }, table: "messages:list" }]);

            // …and it did NOT ask for a fresh snapshot.
            expect(wireFrames(socket).filter((frame) => frame.type === "subscribe")).toHaveLength(1);

            client.close();
        });

        it("re-subscribes for a snapshot (and never publishes the raw envelope) when a delta can't merge into the cached shape", () => {
            expect.assertions(4);

            const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

            try {
                const client = new LunoraClient({
                    fetch: async () => jsonResponse({ result: null }),
                    url: "https://app.example",
                    WebSocket: createMockWebSocket(),
                });

                const received: unknown[] = [];

                client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

                const socket = latestSocket();

                socket.open();

                const sub = firstSub(socket);

                socket.receive({ id: sub.id, type: "ack" });
                // Cached value is a scalar aggregate, not an id-keyed list.
                socket.receive({ cursor: 4, data: { count: 0 }, id: sub.id, type: "data" });
                // A structured delta can't splice into a non-array. Publishing the
                // delta envelope itself as the query's value would render
                // `{ key, op, table, row }` to every subscriber — and the frame also
                // carries a cursor, so nothing would ever reconcile it.
                socket.receive({ cursor: 5, delta: { key: "a", op: "insert", row: { _id: "a" }, table: "messages" }, id: sub.id, type: "delta" });

                expect(received).toStrictEqual([{ count: 0 }]);

                // Recovery: a fresh subscribe frame with NO `sinceSeq`, so the
                // server answers with a full snapshot rather than a bare `resume`.
                const frames = socket.sent.filter((frame) => (JSON.parse(frame) as { type?: string }).type === "subscribe");

                expect(frames).toHaveLength(2);
                expect((JSON.parse(frames[1] as string) as { query: { sinceSeq?: number } }).query.sinceSeq).toBeUndefined();
                expect(warn).toHaveBeenCalledTimes(1);
            } finally {
                warn.mockRestore();
            }
        });
    });

    // --- Offline queue ----------------------------------------------------------

    describe("lunoraClient — offline queue", () => {
        it("mutation issued while the socket is offline is queued and replayed on reconnect", async () => {
            expect.assertions(3);

            vi.useFakeTimers();
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                // Disable the keepalive: this test drains every pending timer
                // with `runAllTimersAsync()`, which never terminates against a
                // recurring heartbeat interval.
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // First, open a real socket so the client considers itself "online".
            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            const first = latestSocket();

            first.open();

            // Drop the socket — we're now offline.
            first.triggerClose();

            // Mutation while offline should be queued, not sent.
            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

            expect(fetchMock).not.toHaveBeenCalled();

            // Advance the reconnect timer and open the next socket.
            vi.advanceTimersByTime(20);
            const second = latestSocket();

            second.open();

            await vi.runAllTimersAsync();

            const value = await pending;

            expect(value).toEqual({ id: "1" });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            client.close();
        });
    });

    // --- Durable offline queue --------------------------------------------------

    describe("lunoraClient — durable offline queue", () => {
        it("hydrates persisted mutations on construct and flushes them once the socket opens", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            // A write durably queued by a prior session (e.g. before a reload).
            await persistence.append({ args: { title: "restored" }, functionPath: "posts:create", id: "m1" });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // The constructor kicks off async hydration which opens a socket for the
            // restored write's shard. Let that settle, then bring the socket up.
            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).toHaveBeenCalledTimes(1);

            const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);

            expect(body).toMatchObject({ args: { title: "restored" }, functionPath: "posts:create" });

            // Removed from durable storage once the server confirmed it.
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("un-persists a replayed mutation even when the server rejects it", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
            const persistence = createInMemoryPersistence();

            await persistence.append({ args: {}, functionPath: "posts:create", id: "m1" });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            // A server verdict (even a rejection) settles the write — replaying it
            // again would only re-trigger the same failure, so it is dropped.
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("a live mutation queued while offline is persisted and removed after replay", async () => {
            expect.assertions(3);

            vi.useFakeTimers();
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));
            const persistence = createInMemoryPersistence();
            const client = new LunoraClient({
                fetch: fetchMock,
                // Disable the keepalive — `runAllTimersAsync()` below never
                // terminates against a recurring heartbeat interval.
                heartbeatIntervalMs: 0,
                persistence,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Get online, then drop the socket so the next mutation is queued.
            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

            await vi.advanceTimersByTimeAsync(0);

            await expect(persistence.load()).resolves.toHaveLength(1);

            // Reconnect and let the flush + remove settle.
            vi.advanceTimersByTime(20);
            latestSocket().open();
            await vi.runAllTimersAsync();

            await expect(pending).resolves.toEqual({ id: "1" });
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("a hydrated write stamped for another identity is dropped, not replayed", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            // A write durably queued by a prior session signed in as user-a.
            await persistence.append({ args: { title: "user-a" }, functionPath: "posts:create", identity: "subj:user-a", id: "m1" });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // A genuinely DIFFERENT user is signed in. (Signed-out is not that
            // case: it is the state of every reload before the app's session
            // resolves, and holds instead — see the offline-lifecycle suite.)
            client.setAuthToken("token-b", "user-b");

            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            // The flush guard rejected the identity mismatch: no RPC was issued
            // for the restored write, and it was un-persisted (dropped) rather
            // than left to resurrect on the next reload.
            expect(fetchMock).not.toHaveBeenCalled();
            expect(sockets.some((socket) => socket.sent.some((frame) => frame.includes("posts:create")))).toBe(false);
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("a legacy hydrated write without a stamp still replays under the current identity", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            // Pre-stamp record (older client): no `identity` field. Back-compat
            // requires it to replay ambiently under whoever is now signed in.
            await persistence.append({ args: { title: "legacy" }, functionPath: "posts:create", id: "m1" });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("a write stamped while signed out does not replay once a user has signed in", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            await persistence.append({ args: { title: "signed-out" }, functionPath: "posts:create", id: "m1", identity: null });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Sign in before hydration settles (queue is still empty, so this
            // does not drain anything). The current identity is now a non-null
            // fingerprint, which must mismatch the persisted `null` stamp at flush.
            client.setAuthToken("signed-in-token");

            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).not.toHaveBeenCalled();
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("replays a coalesced multi-write flush atomically under the queued identity", async () => {
            expect.assertions(4);

            // Two writes queue under identity A. On reconnect they coalesce into
            // ONE rpc-batch replay (plan 088 follow-on). A token rotation to
            // identity B that races the in-flight batch must NOT split it or leak a
            // write under B: the batch carries A's auth header (captured before the
            // rotation), so both writes replay under the identity they were queued
            // with — a write stamped under one identity never goes out under another.
            vi.useFakeTimers();

            const authSeen: (string | undefined)[] = [];
            let rotate: (() => void) | undefined;

            const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
                const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;

                authSeen.push(headers["authorization"]);

                // Race a rotation to identity B against the in-flight batch.
                rotate?.();
                rotate = undefined;

                return jsonResponse({
                    results: [
                        { body: { result: { ok: true } }, id: 0 },
                        { body: { result: { ok: true } }, id: 1 },
                    ],
                });
            });

            const client = new LunoraClient({
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("user-a-token");

            // Get online so the queue arms, then drop the socket so the writes
            // queue instead of sending immediately.
            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            const first = client.mutation(fnRef("posts:create"), { title: "first" });
            const second = client.mutation(fnRef("posts:create"), { title: "second" });

            // Rotate identity once the batch replay is in flight.
            rotate = () => {
                client.setAuthToken("user-b-token");
            };

            // Reconnect and flush.
            await vi.advanceTimersByTimeAsync(20);
            latestSocket().open();
            await vi.runAllTimersAsync();

            // Both writes replayed — in ONE batch, under identity A's auth header
            // (never user-b, even though the token rotated mid-flight).
            await expect(first).resolves.toEqual({ ok: true });
            await expect(second).resolves.toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(authSeen).toEqual(["Bearer user-a-token"]);

            client.close();
        });

        it("a same-subject token refresh during the offline window keeps the queued writes", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Same user (subject "user-1"), initial access token.
            client.setAuthToken("token-v1", "user-1");

            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

            // The access token is refreshed (new JWT) for the SAME user before flush.
            client.setAuthToken("token-v2", "user-1");

            // Reconnect and flush.
            await vi.advanceTimersByTimeAsync(20);
            latestSocket().open();
            await vi.runAllTimersAsync();

            // The write survives the refresh (identity keyed on subject, not token).
            await expect(pending).resolves.toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            client.close();
            vi.useRealTimers();
        });

        it("re-stamps queued writes when the subject is established later on the same token (no drop)", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // The common React pattern: token set before the user id is known
            // (`user?.id` is transiently undefined), so identity is the token hash.
            client.setAuthToken("token-1");

            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            const pending = client.mutation(fnRef("posts:create"), { title: "queued" });

            // The user id resolves a tick later — SAME token, just a stabler label.
            // The in-flight write must be re-stamped, not dropped.
            client.setAuthToken("token-1", "user-1");

            await vi.advanceTimersByTimeAsync(20);
            latestSocket().open();
            await vi.runAllTimersAsync();

            await expect(pending).resolves.toEqual({ ok: true });
            expect(fetchMock).toHaveBeenCalledTimes(1);

            client.close();
            vi.useRealTimers();
        });

        it("a hydrated write stamped under a token replays after the subject is established on that same token", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const persistence = createInMemoryPersistence();

            // Compute the token-hash "token-1" fingerprints to — the stamp a write
            // queued before the subject resolved would carry.
            const probe = new LunoraClient({ url: "https://app.example", WebSocket: createMockWebSocket() });

            probe.setAuthToken("token-1");
            const tokenHash = probe.currentIdentity();

            probe.close();

            // A durable write persisted under the token hash (subject not yet known).
            await persistence.append({ args: { title: "queued" }, functionPath: "posts:create", id: "m1", identity: tokenHash });

            const client = new LunoraClient({
                fetch: fetchMock,
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // On reload the app re-sets the SAME token and now knows the user id, so
            // the live identity is `subj:user-1`. The hydrated write still carries
            // the token hash; it must replay (the credential never changed) rather
            // than be dropped as an identity mismatch.
            client.setAuthToken("token-1", "user-1");

            await flushMicrotasks();
            latestSocket().open();
            await flushMicrotasks();

            expect(fetchMock).toHaveBeenCalledTimes(1);
            await expect(persistence.load()).resolves.toEqual([]);

            client.close();
        });

        it("pendingCount and onPendingChange track queued writes draining on reconnect", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            // Two same-shard writes coalesce into one rpc-batch on flush; the mock
            // answers the batch endpoint with a per-slot result envelope.
            const fetchMock = vi.fn<typeof fetch>(async (input) => {
                if ((input as string).endsWith("/_lunora/rpc-batch")) {
                    return jsonResponse({
                        results: [
                            { body: { result: { ok: true } }, id: 0 },
                            { body: { result: { ok: true } }, id: 1 },
                        ],
                    });
                }

                return jsonResponse({ result: { ok: true } });
            });
            const client = new LunoraClient({
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const counts: number[] = [];

            client.onPendingChange((n) => counts.push(n));

            // Fires immediately with the current (0) count.
            expect(client.pendingCount()).toBe(0);

            client.subscribe(fnRef("posts:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().triggerClose();

            // Two writes queue offline → pending count climbs.
            client.mutation(fnRef("posts:create"), { title: "a" }).catch(() => undefined);
            client.mutation(fnRef("posts:create"), { title: "b" }).catch(() => undefined);

            expect(client.pendingCount()).toBe(2);

            // Reconnect → flush drains the queue.
            await vi.advanceTimersByTimeAsync(20);
            latestSocket().open();
            await vi.runAllTimersAsync();

            expect(client.pendingCount()).toBe(0);
            // The observer saw the climb to 2 and the drain back to 0.
            expect(counts).toEqual(expect.arrayContaining([0, 1, 2, 0]));

            client.close();
            vi.useRealTimers();
        });
    });

    // --- Optimistic updates -----------------------------------------------------

    describe("lunoraClient — optimistic updates", () => {
        it("applies optimistic value immediately and rolls back on error", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();

            // Seed the subscriber with a server value.
            const subId = firstSub(socket).id as string;

            socket.receive({ delta: 5, id: subId, type: "delta" });

            expect(received).toEqual([5]);

            await expect(
                client.mutation(
                    fnRef("counter:get"),
                    {},
                    {
                        optimistic: (current) => (typeof current === "number" ? current + 1 : 1),
                    },
                ),
            ).rejects.toMatchObject({ message: "fail" });

            // Optimistic value applied, then rolled back.
            expect(received).toEqual([5, 6, 5]);
        });

        it("optimistic value is preserved on success", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("c:get"), {}, (d) => received.push(d));
            latestSocket().open();
            const subId = firstSub(latestSocket()).id as string;

            latestSocket().receive({ delta: 0, id: subId, type: "delta" });

            await client.mutation(fnRef("c:get"), {}, { optimistic: () => 9 });

            expect(received).toEqual([0, 9]);
        });

        it("stacked optimistic mutations: an older failure rebases the newer pending write onto the base", async () => {
            expect.assertions(2);

            // Two outstanding RPCs on the same (fn, args, shard) subscription. The
            // older one (A) rejects first; its rollback drops only A's layer and
            // re-folds the still-pending B onto the authoritative base — so B's
            // displayed value drops from 2 to 1 (only B's increment on base 0),
            // rather than leaving a stale 2 that double-counts the rejected A.
            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ delta: 0, id: subId, type: "delta" });

            // A: 0 -> 1, then B: 1 -> 2 (both optimistic, both in-flight).
            const promiseA = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });
            const promiseB = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            expect(received).toEqual([0, 1, 2]);

            // A fails first → drop A's layer, re-fold B onto base 0 → 1.
            deferreds[0]!.reject(new Error("A failed"));
            await promiseA.catch(() => undefined);

            // Settle B (success). The response carries no commitCursor, so B's layer
            // is dropped silently (no further notify).
            deferreds[1]!.resolve(jsonResponse({ result: { ok: true } }));
            await promiseB;

            // B was rebased onto the base when A was rejected — its increment now
            // reflects only itself (1), not the double-counted 2.
            expect(received).toEqual([0, 1, 2, 1]);
        });

        it("drops a confirmed optimistic layer once a frame reaches its commit cursor (no double-count)", async () => {
            expect.assertions(1);

            // The mutation response echoes the CDC cursor the write committed at.
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ cursor: 5, data: 5, id: subId, type: "data" });
            // Optimistic +1 → 6; response confirms commit at cursor 10 (not yet reached).
            await client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            // The confirming frame lands at cursor 10 carrying the authoritative 6.
            // The layer (commit cursor 10) drops; the value is already 6, so no
            // spurious re-notify fires — and crucially it is NOT 7 (which a
            // still-applied layer would fold on top).
            socket.receive({ cursor: 10, data: 6, id: subId, type: "data" });

            expect(received).toEqual([5, 6]);
        });

        it("self-heals the H1 race when the confirming frame beats the RPC response", async () => {
            expect.assertions(2);

            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ cursor: 5, data: 5, id: subId, type: "data" });
            const pending = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            // The confirming frame (cursor 10, authoritative 6) arrives BEFORE the
            // RPC response. The layer's commit cursor is unknown, so it's still
            // folded → a transient 7 (this is the race the reverted version left
            // permanent).
            socket.receive({ cursor: 10, data: 6, id: subId, type: "data" });

            expect(received).toEqual([5, 6, 7]);

            // The response lands with commitCursor 10; the layer is now confirmed at
            // an already-reached cursor → dropped + re-folded → corrects to 6.
            deferreds[0]!.resolve(jsonResponse({ commitCursor: 10, result: { ok: true } }));
            await pending;

            // No permanent double-count: it self-heals to the authoritative value.
            expect(received).toEqual([5, 6, 7, 6]);
        });

        it("rebases a pending optimistic value onto an unrelated incoming delta (not clobbered)", async () => {
            expect.assertions(2);

            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ cursor: 5, data: 5, id: subId, type: "data" });
            // Optimistic +1 → 6; the RPC stays in flight (commit cursor unknown).
            const pending = client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            expect(received).toEqual([5, 6]);

            // An UNRELATED server delta moves the base to 10 (e.g. another client).
            // The still-pending layer is REBASED onto 10 → 11, not clobbered to 10.
            socket.receive({ cursor: 8, data: 10, id: subId, type: "data" });

            expect(received).toEqual([5, 6, 11]);

            deferreds[0]!.reject(new Error("done"));
            await pending.catch(() => undefined);
        });

        it("drops a confirmed optimistic layer on a byte-identical settled frame (no stuck overlay)", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ commitCursor: 10, result: { ok: true } }));
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            const received: unknown[] = [];

            client.subscribe(fnRef("counter:get"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ cursor: 5, data: 5, id: subId, type: "data" });
            // Optimistic +1 → 6; commit cursor 10 (not yet reached → layer kept).
            await client.mutation(fnRef("counter:get"), {}, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            expect(received).toEqual([5, 6]);

            // The write committed at cursor 10 but the query result is byte-identical,
            // so the server sends a `settled` frame (no data). The layer is confirmed
            // at 10 ≤ 10 → dropped → reverts to the authoritative base 5 (no stuck +1).
            socket.receive({ cursor: 10, id: subId, type: "settled" });

            expect(received).toEqual([5, 6, 5]);
        });

        it("optimisticUpdate patches two different subscribed queries and rolls both back on error", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "BOOM", message: "fail" } }, { status: 500 }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const aReceived: unknown[] = [];
            const bReceived: unknown[] = [];

            client.subscribe(fnRef("q:a"), {}, (d) => aReceived.push(d));
            client.subscribe(fnRef("q:b"), {}, (d) => bReceived.push(d));
            const socket = latestSocket();

            socket.open();

            const aId = firstSub(socket).id as string;
            const bId = wireFrames(socket)[1].id as string;

            socket.receive({ delta: 1, id: aId, type: "delta" });
            socket.receive({ delta: 10, id: bId, type: "delta" });

            await expect(
                client.mutation(
                    fnRef("m:both"),
                    {},
                    {
                        optimisticUpdate: (store) => {
                            store.setQuery(fnRef("q:a"), {}, 2);
                            store.setQuery(fnRef("q:b"), {}, 20);
                        },
                    },
                ),
            ).rejects.toMatchObject({ message: "fail" });

            // Both queries patched optimistically, then both rolled back on error.
            expect(aReceived).toEqual([1, 2, 1]);
            expect(bReceived).toEqual([10, 20, 10]);
        });

        it("optimisticUpdate value is preserved on success", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, (d) => received.push(d));
            latestSocket().open();
            const subId = firstSub(latestSocket()).id as string;

            latestSocket().receive({ delta: 0, id: subId, type: "delta" });

            await client.mutation(
                fnRef("m:set"),
                {},
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("q:list"), {}, 42);
                    },
                },
            );

            expect(received).toEqual([0, 42]);
        });

        it("optimisticUpdate rebases onto an unrelated delta instead of being clobbered", async () => {
            expect.assertions(2);

            // Unification win: the multi-query optimisticUpdate path now rides the
            // same rebaseable layer engine as per-call `optimistic`, so its value
            // survives an unrelated server delta on the same query (it used to be
            // clobbered one-shot).
            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            const received: unknown[] = [];

            client.subscribe(fnRef("q:list"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ cursor: 5, data: 5, id: subId, type: "data" });
            // optimisticUpdate sets the query to 42; the RPC stays in flight.
            const pending = client.mutation(
                fnRef("m:set"),
                {},
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("q:list"), {}, 42);
                    },
                },
            );

            // An unrelated server delta moves the base to 10. The optimistic 42
            // survives (rebased), rather than being clobbered to 10.
            socket.receive({ cursor: 8, data: 10, id: subId, type: "data" });

            expect(received.at(-1)).toBe(42);
            expect(received).not.toContain(10);

            deferreds[0]!.reject(new Error("done"));
            await pending.catch(() => undefined);
        });

        it("stacked optimisticUpdate mutations compose without clobbering each other", async () => {
            expect.assertions(2);

            const deferreds: { reject: (error: unknown) => void; resolve: (value: Response) => void }[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve, reject) => {
                        deferreds.push({ reject, resolve });
                    }),
            );
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("q:n"), {}, (d) => received.push(d));
            const socket = latestSocket();

            socket.open();
            const subId = firstSub(socket).id as string;

            socket.receive({ delta: 0, id: subId, type: "delta" });

            // A: 0 -> 1, then B: 1 -> 2, both via optimisticUpdate, both in-flight.
            const inc: OptimisticUpdate<unknown> = (store) => {
                store.setQuery(fnRef("q:n"), {}, ((store.getQuery(fnRef("q:n"), {}) as number) ?? 0) + 1);
            };
            const promiseA = client.mutation(fnRef("m:inc"), {}, { optimisticUpdate: inc });
            const promiseB = client.mutation(fnRef("m:inc"), {}, { optimisticUpdate: inc });

            expect(received).toEqual([0, 1, 2]);

            // A fails first; its rollback must leave B's pending value (2) intact.
            deferreds[0]!.reject(new Error("A failed"));
            await promiseA.catch(() => undefined);

            deferreds[1]!.resolve(jsonResponse({ result: { ok: true } }));
            await promiseB;

            expect(received).toEqual([0, 1, 2]);
        });

        it("setQuery on an unsubscribed query is a no-op", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            client.subscribe(fnRef("q:watched"), {}, (d) => received.push(d));
            latestSocket().open();
            const subId = firstSub(latestSocket()).id as string;

            latestSocket().receive({ delta: 0, id: subId, type: "delta" });

            // Patching an unsubscribed query writes nothing and produces no rollback.
            const result = await client.mutation(
                fnRef("m:noop"),
                {},
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("q:unwatched"), {}, 99);
                    },
                },
            );

            expect(received).toEqual([0]);
            expect(result).toEqual({ ok: true });
        });

        it("optimisticUpdate lands when the subscription's undefined shardKey and the mutation's empty-string shardKey normalize equal", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: unknown[] = [];

            // Subscription registered WITHOUT a shardKey (state.shardKey === undefined).
            client.subscribe(fnRef("q:list"), {}, (d) => received.push(d));
            latestSocket().open();
            const subId = firstSub(latestSocket()).id as string;

            latestSocket().receive({ delta: 0, id: subId, type: "delta" });

            // Mutation issued with an EMPTY-STRING shardKey. Both sides normalize to
            // "" in the registry key, so the optimistic patch must land — a strict
            // `undefined === ""` compare in the old findState would silently no-op it.
            await client.mutation(
                fnRef("m:set"),
                {},
                {
                    optimisticUpdate: (store) => {
                        store.setQuery(fnRef("q:list"), {}, 42);
                    },
                    shardKey: "",
                },
            );

            expect(received).toEqual([0, 42]);
        });

        it("optimistic update is scoped to the matching (fn, args) pair and does not touch subscriptions with different args", async () => {
            // This test locks in the keyed-lookup invariant: an optimistic transform
            // applied to (fn, { room: "a" }) must NOT bleed into the subscription
            // for (fn, { room: "b" }) even though both watch the same function.
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const aReceived: unknown[] = [];
            const bReceived: unknown[] = [];

            client.subscribe(fnRef("c:get"), { room: "a" }, (d) => aReceived.push(d));
            client.subscribe(fnRef("c:get"), { room: "b" }, (d) => bReceived.push(d));
            const socket = latestSocket();

            socket.open();

            const aId = firstSub(socket).id as string;
            const bId = wireFrames(socket)[1].id as string;

            socket.receive({ delta: 10, id: aId, type: "delta" });
            socket.receive({ delta: 20, id: bId, type: "delta" });

            // Mutation targets { room: "a" } only — subscription B must be unchanged.
            await client.mutation(fnRef("c:get"), { room: "a" }, { optimistic: (c) => (typeof c === "number" ? c + 1 : 1) });

            expect(aReceived).toEqual([10, 11]);
            expect(bReceived).toEqual([20]);
        });
    });

    // --- Scheduler admin --------------------------------------------------------

    describe("lunoraClient — scheduler admin", () => {
        it("listScheduledJobs GETs the admin endpoint with the bearer and unwraps records", async () => {
            expect.assertions(4);

            const records = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2000 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ records }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("tkn");

            const result = await client.listScheduledJobs();

            expect(result).toEqual(records);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/scheduled");
            expect(init.method).toBe("GET");
            expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tkn");
        });

        // The admin routes PROXY the SchedulerDO's stored records byte for byte,
        // and `ctx.scheduler.runAt` stores `encodeWire(args)`. The proxy cannot
        // decode on the way through — it re-serializes with `JSON.stringify`,
        // which throws on the very `bigint` the encode exists to carry — so the
        // decode belongs here, at the consumer, where `createScheduler.list()`
        // does it for a shard-side reader.
        it("decodes record args on the admin list reads so they match what was scheduled", async () => {
            expect.assertions(2);

            const args = { amount: 1234n, when: new Date(0) };
            const stored = { args: encodeWire(args), enqueuedAt: 1, functionPath: "billing:settle", id: "j1", scheduledFor: 2000 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ records: [stored] }));

            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            client.setAuthToken("tkn");

            await expect(client.listScheduledJobs()).resolves.toStrictEqual([{ ...stored, args }]);
            await expect(client.listDeadJobs()).resolves.toStrictEqual([{ ...stored, args }]);
        });

        it("listDeadJobs walks every page rather than stopping at the first", async () => {
            expect.assertions(3);

            // `/dead` is a bounded, cursored read — a shard that dead-lettered
            // thousands of jobs cannot serialize them all in one response. But
            // this list is the ONLY view of a permanently-failed job and the only
            // way to requeue one, so returning `records` alone silently hid
            // exactly the backlog an operator opens the panel to find.
            const page1 = Array.from({ length: 100 }, (_unused, index) => {
                return {
                    args: {},
                    enqueuedAt: 1,
                    functionPath: "email:send",
                    id: `d${String(index)}`,
                    scheduledFor: 2000,
                };
            });
            const page2 = [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "d100", scheduledFor: 2000 }];

            const fetchMock = vi.fn<typeof fetch>(async (input) => {
                // `fetch`'s input is `string | URL | Request`; only a URL string
                // can be substring-matched for the cursor.
                const requested = input instanceof Request ? input.url : String(input);

                return requested.includes("cursor=")
                    ? jsonResponse({ records: page2, truncated: false })
                    : jsonResponse({ cursor: "dead:d99", records: page1, truncated: true });
            });

            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            client.setAuthToken("tkn");

            const result = await client.listDeadJobs();

            expect(result).toHaveLength(101);
            expect(fetchMock).toHaveBeenCalledTimes(2);

            const [secondUrl] = fetchMock.mock.calls[1] as unknown as [string];

            expect(secondUrl).toBe("https://app.example/_lunora/admin/scheduled/dead?cursor=dead%3Ad99");
        });

        it("listScheduledJobs defaults to an empty array when records are absent", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listScheduledJobs()).resolves.toEqual([]);
        });

        it("cancelScheduledJob POSTs the id and normalises the result", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ cancelled: true }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.cancelScheduledJob("j1");

            expect(result).toEqual({ cancelled: true });

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/scheduled/cancel");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({ id: "j1" });
        });

        it("schedulerStatus GETs the status endpoint with the bearer and returns the backlog", async () => {
            expect.assertions(4);

            const status = { backlog: 5, inFlight: 2, pools: [{ inFlight: 2, maxConcurrency: 3, name: "mail", queued: 5 }] };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(status));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("tkn");

            const result = await client.schedulerStatus();

            expect(result).toEqual(status);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/scheduled/status");
            expect(init.method).toBe("GET");
            expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer tkn");
        });

        it("schedulerStatus defaults absent fields to an empty backlog", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.schedulerStatus()).resolves.toEqual({ backlog: 0, inFlight: 0, pools: [] });
        });

        it("scheduler admin surfaces the worker error envelope as a coded Error", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ error: { code: "ADMIN_FORBIDDEN", message: "nope" } }, { status: 403 }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listScheduledJobs()).rejects.toMatchObject({ code: "ADMIN_FORBIDDEN", message: "nope" });
        });
    });

    // --- Storage admin ----------------------------------------------------------

    describe("lunoraClient — storage admin", () => {
        it("listStorageObjects GETs the admin endpoint and unwraps the page", async () => {
            expect.assertions(3);

            const page = { cursor: "c1", objects: [{ etag: "e1", key: "a.png", size: 10 }] };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.listStorageObjects();

            expect(result).toEqual(page);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/storage");
            expect(init.method).toBe("GET");
        });

        it("listStorageObjects encodes prefix / cursor / limit as query params", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ objects: [] }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.listStorageObjects({ cursor: "z", limit: 25, prefix: "avatars/" });

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/storage");
            expect(parsed.searchParams.get("prefix")).toBe("avatars/");
            expect(parsed.searchParams.get("cursor")).toBe("z");
            expect(parsed.searchParams.get("limit")).toBe("25");
        });

        it("listStorageObjects defaults objects to an empty array", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listStorageObjects()).resolves.toEqual({ cursor: undefined, objects: [] });
        });

        it("listStorageObjects forwards the selected bucket as a query param", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ objects: [] }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.listStorageObjects({ bucket: "media", prefix: "p/" });

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];

            expect(new URL(requestUrl).searchParams.get("bucket")).toBe("media");
        });

        it("listStorageBuckets GETs the buckets endpoint and unwraps the list", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ buckets: ["default", "media"] }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listStorageBuckets()).resolves.toEqual(["default", "media"]);

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];

            expect(new URL(requestUrl).pathname).toBe("/_lunora/admin/storage/buckets");
        });

        it("listStorageBuckets defaults to an empty array", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listStorageBuckets()).resolves.toEqual([]);
        });

        it("deleteStorageObject DELETEs the key and normalises the result", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ deleted: true, key: "avatars/a.png" }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.deleteStorageObject("avatars/a.png");

            expect(result).toEqual({ deleted: true, key: "avatars/a.png" });

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/storage");
            expect(parsed.searchParams.get("key")).toBe("avatars/a.png");
            expect(init.method).toBe("DELETE");
        });

        it("uploadStorageObject PUTs the body with the content-type header", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ etag: "e9", key: "docs/r.txt" }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const bytes = new TextEncoder().encode("hello").buffer;
            const result = await client.uploadStorageObject({ body: bytes, contentType: "text/plain", key: "docs/r.txt" });

            expect(result).toEqual({ etag: "e9", key: "docs/r.txt" });

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const parsed = new URL(requestUrl);

            expect(parsed.searchParams.get("key")).toBe("docs/r.txt");
            expect(init.method).toBe("PUT");
            expect((init.headers as Record<string, string>)["content-type"]).toBe("text/plain");
        });

        it("signedStorageUrl GETs the URL endpoint and unwraps the url", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ key: "a.png", url: "https://cdn.example/a.png?sig=x" }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.signedStorageUrl("a.png");

            expect(result).toBe("https://cdn.example/a.png?sig=x");

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/storage/url");
            expect(init.method).toBe("GET");
        });

        it("signedStorageUrl forwards an expiresIn query when given a lifetime", async () => {
            expect.assertions(2);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ key: "a.png", url: "https://cdn.example/a.png?sig=x" }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.signedStorageUrl("a.png", { expiresInSeconds: 900 });

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.searchParams.get("key")).toBe("a.png");
            expect(parsed.searchParams.get("expiresIn")).toBe("900");
        });

        it("signedStorageUrl throws when the endpoint returns no url", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ key: "a.png" }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.signedStorageUrl("a.png")).rejects.toThrow("no `url`");
        });
    });

    // --- Functions admin --------------------------------------------------------

    describe("lunoraClient — functions admin", () => {
        it("listFunctions GETs the admin endpoint and unwraps the list", async () => {
            expect.assertions(3);

            const functions = [
                { kind: "query", path: "messages:list" },
                { kind: "mutation", path: "messages:send" },
            ];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ functions }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listFunctions()).resolves.toEqual(functions);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/functions");
            expect(init.method).toBe("GET");
        });

        it("listFunctions defaults to an empty array when functions are absent", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listFunctions()).resolves.toEqual([]);
        });

        it("getCronJobs GETs the admin endpoint and unwraps the list", async () => {
            expect.assertions(3);

            const jobs = [
                { cron: "0 9 * * *", functionPath: "report:daily", name: "daily digest" },
                { cron: "*/5 * * * *", functionPath: "presence:clear", name: "clear presence", shardKey: "acme" },
            ];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ jobs }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.getCronJobs()).resolves.toEqual(jobs);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/cron-jobs");
            expect(init.method).toBe("GET");
        });

        it("getCronJobs defaults to an empty array when jobs are absent", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.getCronJobs()).resolves.toEqual([]);
        });
    });

    // --- Global (D1) tables admin -----------------------------------------------

    describe("lunoraClient — global tables admin", () => {
        it("listGlobalTables GETs the admin endpoint", async () => {
            expect.assertions(3);

            const tables = [{ name: "organizations", rowCount: 2 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(tables));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listGlobalTables()).resolves.toEqual(tables);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/global/tables");
            expect(init.method).toBe("GET");
        });

        it("readGlobalTablePage encodes table / limit / offset as query params", async () => {
            expect.assertions(5);

            const page = { columns: ["_id"], rows: [{ _id: "o1" }], total: 1 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.readGlobalTablePage({ limit: 10, offset: 5, table: "organizations" })).resolves.toEqual(page);

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/global/table");
            expect(parsed.searchParams.get("table")).toBe("organizations");
            expect(parsed.searchParams.get("limit")).toBe("10");
            expect(parsed.searchParams.get("offset")).toBe("5");
        });

        it("readGlobalTablePage decodes the wire-encoded page the worker sends", async () => {
            expect.assertions(2);

            // Exactly what `readGlobalTablePage` in `@lunora/d1` puts on the wire:
            // JSON cannot carry a `v.bigint()` column at all and flattens a
            // `v.bytes()` one to `{}`, so the worker tags them. Without a decode on
            // this side the studio grid renders the raw 3-element tagged array.
            const page = encodeWire({
                columns: ["_id", "cents", "blob"],
                rows: [{ _id: "l1", blob: new Uint8Array([7, 8, 9]).buffer, cents: 9_007_199_254_740_993n }],
                total: 1,
            });
            const client = new LunoraClient({
                fetch: async () => jsonResponse(page),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const decoded = await client.readGlobalTablePage({ table: "ledger" });

            expect(decoded.rows[0]?.["cents"]).toBe(9_007_199_254_740_993n);
            expect([...new Uint8Array(decoded.rows[0]?.["blob"] as ArrayBuffer)]).toStrictEqual([7, 8, 9]);
        });

        it("facetGlobalColumn decodes the facet values and wire-encodes the filters it sends back", async () => {
            expect.assertions(3);

            const facet = encodeWire({ truncated: false, values: [{ count: 1, value: new Uint8Array([7, 8, 9]) }] });
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(facet));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const decoded = await client.facetGlobalColumn({
                column: "blob",
                filters: [{ column: "blob", value: new Uint8Array([1, 2]) }],
                table: "ledger",
            });

            expect([...(decoded.values[0]?.value as Uint8Array)]).toStrictEqual([7, 8, 9]);

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const filters = new URL(requestUrl).searchParams.get("filters");

            // The value a click sends back is the one the facet just handed over,
            // so it has to survive the outbound leg too: a bare `JSON.stringify`
            // empties bytes to `{}` and the drill-down then matches nothing.
            expect(filters).toBe(JSON.stringify(encodeWire([{ column: "blob", value: new Uint8Array([1, 2]) }])));
            expect(filters).not.toContain("{}");
        });
    });

    describe("lunoraClient — vector indexes admin", () => {
        it("listVectorIndexes GETs the admin endpoint and unwraps the list", async () => {
            expect.assertions(3);

            const indexes = [{ dimensions: 1024, field: "body", metric: "cosine", name: "by_body", table: "docs", vectorsCount: 42 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ indexes }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listVectorIndexes()).resolves.toEqual(indexes);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/vector/indexes");
            expect(init.method).toBe("GET");
        });

        it("listVectorIndexes defaults to an empty array when indexes are absent", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listVectorIndexes()).resolves.toEqual([]);
        });

        it("queryVectorIndex POSTs name/text/topK and unwraps the matches", async () => {
            expect.assertions(4);

            const matches = [{ id: "row-1", metadata: { title: "hi" }, score: 0.9 }];
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ matches }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.queryVectorIndex({ name: "by_body", text: "hello", topK: 5 })).resolves.toEqual(matches);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/vector/query");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({ name: "by_body", text: "hello", topK: 5 });
        });
    });

    describe("lunoraClient — auth admin", () => {
        it("listAuthUsers GETs the users endpoint with paging", async () => {
            expect.assertions(4);

            const page = { rows: [{ id: "u1" }], total: 1 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.listAuthUsers({ limit: 10, offset: 5 })).resolves.toEqual(page);

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/auth/users");
            expect(parsed.searchParams.get("limit")).toBe("10");
            expect(parsed.searchParams.get("offset")).toBe("5");
        });

        it("listAuthSessions encodes userId + paging", async () => {
            expect.assertions(3);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [], total: 0 }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.listAuthSessions({ limit: 20, userId: "u1" });

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string];
            const parsed = new URL(requestUrl);

            expect(parsed.pathname).toBe("/_lunora/admin/auth/sessions");
            expect(parsed.searchParams.get("userId")).toBe("u1");
            expect(parsed.searchParams.get("limit")).toBe("20");
        });
    });

    describe("lunoraClient — connection status", () => {
        it("reports idle before any socket, then connecting/connected/offline across the socket lifecycle", () => {
            expect.assertions(6);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const seen: string[] = [];
            const unsubscribe = client.onConnectionStatus((status) => seen.push(status));

            // Fires immediately with the current (idle) status.
            expect(seen).toEqual(["idle"]);
            expect(client.connectionStatus()).toBe("idle");

            // Opening a subscription creates a socket → connecting.
            client.subscribe(fnRef("a:b"), {}, () => undefined);

            expect(client.connectionStatus()).toBe("connecting");

            const socket = latestSocket();

            socket.open();

            expect(client.connectionStatus()).toBe("connected");

            // Drop drops to offline (between reconnect attempts).
            socket.triggerClose();

            expect(client.connectionStatus()).toBe("offline");

            expect(seen).toEqual(["idle", "connecting", "connected", "offline"]);

            // This test's own `triggerClose()` armed a REAL 10ms reconnect
            // timer (no fake timers here) — without closing, it fires during
            // whatever test happens to be running ~10ms later and leaks a
            // stray, un-tokened socket into that test's `sockets` array.
            unsubscribe();
            client.close();
        });

        it("stops notifying after unsubscribe", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const seen: string[] = [];
            const unsubscribe = client.onConnectionStatus((status) => seen.push(status));

            unsubscribe();
            client.subscribe(fnRef("a:b"), {}, () => undefined);

            // Only the immediate idle callback landed before unsubscribe.
            expect(seen).toEqual(["idle"]);
        });

        it("close() releases auth/status listeners so they no longer fire", () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const tokens: (string | null)[] = [];
            const statuses: string[] = [];

            client.onAuthTokenChange((token) => tokens.push(token));
            // onConnectionStatus fires once immediately with the current status.
            client.onConnectionStatus((status) => statuses.push(status));

            client.close();

            // After close() the listener registries are cleared, so a later
            // token change must not invoke the previously-registered listener.
            client.setAuthToken("post-close-token");

            // The auth listener never fired (close cleared the Set before the
            // token change), and the status listener only saw the immediate
            // idle callback from registration — nothing post-close.
            expect(tokens).toEqual([]);
            expect(statuses).toEqual(["idle"]);
        });
    });

    describe("lunoraClient — scheduled-jobs subscription", () => {
        // The live push carries the same stored records the HTTP list does, so it
        // decodes on the same terms — otherwise a panel showed tagged tuples the
        // instant a job changed and real values on the next poll.
        it("decodes record args on a pushed job list", () => {
            expect.assertions(1);

            const args = { amount: 1234n };
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const seen: unknown[] = [];
            const unsubscribe = client.subscribeScheduledJobs((jobs) => seen.push(jobs[0]?.args));

            latestSocket().open();
            latestSocket().receive({
                records: [{ args: encodeWire(args), enqueuedAt: 1, functionPath: "billing:settle", id: "j1", scheduledFor: 2 }],
                type: "jobs",
            });

            expect(seen).toStrictEqual([args]);

            unsubscribe();
        });

        it("opens the scheduler admin WS with the token and delivers pushed job lists", () => {
            expect.assertions(4);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const seen: string[][] = [];
            const unsubscribe = client.subscribeScheduledJobs((jobs) => seen.push(jobs.map((job) => job.id)));

            const socket = latestSocket();

            // Connects to the scheduler WS path with the admin token in the query.
            expect(socket.url).toContain("/_lunora/admin/scheduled/ws");
            expect(socket.url).toContain("token=adm1n");

            socket.open();
            socket.receive({ records: [{ args: {}, enqueuedAt: 1, functionPath: "email:send", id: "j1", scheduledFor: 2 }], type: "jobs" });

            expect(seen).toEqual([["j1"]]);

            // A frame of the wrong type is ignored.
            socket.receive({ type: "other" });

            expect(seen).toHaveLength(1);

            unsubscribe();
            client.close();
        });

        it("reconnects after the socket drops", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            vi.advanceTimersByTime(15);

            const second = latestSocket();

            expect(second).not.toBe(first);
            expect(second.url).toContain("/_lunora/admin/scheduled/ws");

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        it("resolves a wsToken provider per connect, re-minting on reconnect", async () => {
            expect.assertions(3);

            vi.useFakeTimers();

            let mints = 0;
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: async () => {
                    mints += 1;

                    return `eph-${String(mints)}`;
                },
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            // The scheduled socket is built only AFTER the async provider
            // resolves (a few microtask hops). Drain until the socket carrying
            // the minted token appears, and pick it by path + token — reading
            // `latestSocket()` could otherwise grab a stray socket (e.g. a prior
            // test's pending reconnect) that raced in during the advance.
            const findScheduled = (needle: string): MockSocket | undefined =>
                sockets.find((socket) => socket.url.includes("/_lunora/admin/scheduled/ws") && socket.url.includes(needle));

            let first: MockSocket | undefined;

            for (let attempt = 0; attempt < 30 && first === undefined; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential drain until the minted socket appears
                await vi.advanceTimersByTimeAsync(0);
                first = findScheduled("token=eph-1");
            }

            expect(first?.url).toContain("token=eph-1");

            first?.open();
            first?.triggerClose();

            // The reconnect (10ms) re-resolves the provider — a fresh short-lived
            // token per attempt, never a reused stale one. Drain until it lands.
            let second: MockSocket | undefined;

            for (let attempt = 0; attempt < 30 && second === undefined; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- sequential drain: fire the 10ms reconnect timer then flush the re-mint hops
                await vi.advanceTimersByTimeAsync(10);
                second = findScheduled("token=eph-2");
            }

            expect(second).not.toBe(first);
            expect(second?.url).toContain("token=eph-2");

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        // `subscribeScheduledJobs` used to run a second, hand-rolled
        // socket-lifecycle implementation alongside the shard path's
        // (`ensureSocket`/`openSocket`/`handleDisconnect`/`startHeartbeat`) —
        // plan 231-D pinned the divergence with characterization tests below
        // but deliberately didn't extract (the shard `ShardConnection` record
        // threads through dozens of call sites; generalizing it blind was
        // judged too risky). Plan 253 did the extraction — both this
        // subscription and the shard socket now build on the shared
        // `openManagedSocket` helper — so the three tests below assert the
        // gaps are CLOSED, not open, plus a fourth pins the specific CLIENT-05
        // bug (a superseded socket's late `close` corrupting the live one)
        // that motivated sharing the shard socket's identity guard.
        it("fails a hung handshake fast — inherits the shard socket's connect-timeout (plan 253)", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new LunoraClient({
                connectTimeoutMs: 5000,
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const first = latestSocket();

            // Handshake hangs forever: `open` never fires. At `connectTimeoutMs`
            // the socket is force-closed and a reconnect is armed — same as the
            // shard socket, no longer stuck `connecting` forever.
            vi.advanceTimersByTime(5010);

            expect(first.readyState).toBe(3);

            const second = latestSocket();

            expect(second).not.toBe(first);
            expect(second.url).toContain("/_lunora/admin/scheduled/ws");

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        it("recycles an open-but-silent socket — inherits the shard socket's heartbeat/watchdog (plan 253)", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                heartbeatIntervalMs: 1000,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const first = latestSocket();

            first.open();

            // Ten minutes with the far end silent (no `jobs` push, no anything).
            // The heartbeat sends keepalive pings every second; none answered
            // means the half-open watchdog (`heartbeatIntervalMs * 2.5`)
            // force-closes and reconnects well within the ten minutes — same as
            // the shard path, no longer stuck "open" forever.
            vi.advanceTimersByTime(600_000);

            expect(first.sent.length).toBeGreaterThan(0);
            expect(first.readyState).toBe(3);

            const second = latestSocket();

            expect(second).not.toBe(first);

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        it("a scheduled socket whose peer answers the keepalive pong is NOT recycled while idle (plan 253 HIGH-sev fix)", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                heartbeatIntervalMs: 1000,
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const socket = latestSocket();

            socket.open();

            // Unlike the silent-peer test above, SchedulerDO now registers the
            // same hibernation-safe `lunora-ping` -> `lunora-pong`
            // auto-response ShardDO already had — the fix for the HIGH-sev
            // regression this closure exercises. Simulate that: every
            // heartbeat tick gets answered. Five ticks span 5000ms, well past
            // the 2500ms half-open window, so a watchdog whose `lastFrameAt`
            // never advanced on the scheduled path's pong (the pre-fix
            // per-caller stamp gap `openManagedSocket` now closes for every
            // caller) would have force-closed by now.
            for (let tick = 0; tick < 5; tick += 1) {
                vi.advanceTimersByTime(1000);
                socket.receive("lunora-pong");
            }

            expect(socket.readyState).toBe(1);

            // No reconnect fired — the socket the subscription is using is
            // still the very first one that opened.
            expect(latestSocket()).toBe(socket);

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        it("a bare error event with no follow-up close arms a reconnect — inherits the shard socket's error handling (plan 253)", () => {
            expect.assertions(1);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const first = latestSocket();

            first.open();
            // Some WS implementations and proxies fire a standalone `error` with
            // no follow-up `close`. `openManagedSocket` now treats it as a
            // disconnect (mirrors the shard socket) and arms reconnect — no
            // longer a silently dead subscription.
            first.triggerError();

            vi.advanceTimersByTime(10);

            const second = latestSocket();

            expect(second).not.toBe(first);

            unsubscribe();
            client.close();
            vi.useRealTimers();
        });

        it("a superseded socket's late close cannot clear the live socket or arm a duplicate reconnect (CLIENT-05)", () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                // Fixed, jitter-free backoff so a single timer advance fires
                // exactly one reconnect.
                reconnect: { initialDelayMs: 1000, jitter: false, maxDelayMs: 1000 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: "adm1n",
            });

            const unsubscribe = client.subscribeScheduledJobs(() => undefined);

            const stale = latestSocket();

            stale.open();

            // The socket drops; the reconnect timer fires and builds a fresh
            // socket that's now this subscription's current one.
            stale.triggerClose();
            vi.advanceTimersByTime(1000);

            const fresh = latestSocket();

            expect(fresh).not.toBe(stale);

            fresh.open();

            // A late, duplicate close from the dead (superseded) socket — the
            // bug this closure had before it shared the shard socket's identity
            // guard: `socket = undefined` was an unconditional reassignment of
            // the whole subscription's SHARED outer variable, so a stale
            // socket's late `close` cleared the LIVE one and armed a second,
            // duplicate reconnect racing the first.
            stale.triggerClose();

            // No duplicate reconnect: advancing past the backoff produces no
            // third socket — `fresh` was healthy and was never torn down.
            vi.advanceTimersByTime(1000);

            expect(sockets.filter((socket) => socket.url.includes("/scheduled/ws"))).toHaveLength(2);

            // The live socket was never cleared: `unsubscribe()` can still find
            // and close it. Under the bug, the stale close's unconditional
            // `socket = undefined` would have left `fresh` leaked open forever.
            unsubscribe();

            expect(fresh.readyState).toBe(3);

            client.close();
            vi.useRealTimers();
        });
    });

    describe("lunoraClient — wsToken provider (ephemeral admin token)", () => {
        it("resolves the provider before the shard socket connects and appends the minted token", async () => {
            expect.assertions(3);

            const provider = vi.fn<() => Promise<string>>(async () => "eph-token");
            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: provider,
            });

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined);

            // No socket yet — the provider's Promise must resolve first.
            expect(sockets).toHaveLength(0);

            await flushMicrotasks();

            // Select the token-bearing socket rather than `latestSocket()`: under
            // full-suite load a stray reconnect socket from an earlier test can be
            // the newest entry, so `.at(-1)` is not reliably the minted one.
            let tokened = sockets.find((socket) => socket.url.includes("token=eph-token"));

            for (let attempt = 0; attempt < 30 && tokened === undefined; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- drain macrotasks until the provider-minted socket opens
                await flushMicrotasks();
                tokened = sockets.find((socket) => socket.url.includes("token=eph-token"));
            }

            expect(tokened?.url).toContain("token=eph-token");
            expect(provider).toHaveBeenCalledTimes(1);

            // Without this, the connect-timeout fail-fast timer (a REAL
            // setTimeout — this test never engages fake timers) stays armed
            // on the un-opened socket and can fire well into a LATER test's
            // run, re-arming the reconnect loop and pushing a stray socket
            // into whatever test happens to be executing when it lands (the
            // exact class of cross-test flake the `sockets.find(...)`
            // workarounds throughout this describe block are defending
            // against — closing the client removes the root cause instead).
            client.close();
        });

        it("re-invokes the provider on the reconnect after a token-expired (4001) drop", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            let mints = 0;
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: async () => {
                    mints += 1;

                    return `eph-${String(mints)}`;
                },
            });

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined);

            await vi.advanceTimersByTimeAsync(0);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            // The reconnect re-invokes the async provider (minting eph-2) before
            // opening the new socket. `latestSocket()` is unreliable here — under
            // full-suite load a stray reconnect socket can be the newest entry (see
            // the sibling test above) — so drain the reconnect backoff + async mint
            // and select the token-bearing reconnect socket explicitly.
            let second = sockets.find((socket) => socket !== first && socket.url.includes("token=eph-2"));

            for (let attempt = 0; attempt < 30 && second === undefined; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- drain fake timers + microtasks until the minted reconnect socket opens
                await vi.advanceTimersByTimeAsync(15);
                second = sockets.find((socket) => socket !== first && socket.url.includes("token=eph-2"));
            }

            expect(second).not.toBe(first);
            expect(second?.url).toContain("token=eph-2");

            // Close WHILE fake timers are still installed, so `close()`'s
            // `clearTimeout`/`clearInterval` calls actually cancel the
            // fake-scheduled reconnect/connect-timeout/heartbeat timers this
            // client armed. Without this, the client is abandoned with those
            // timers still pending; switching to real timers doesn't fire
            // them, but it also doesn't guarantee they're gone — leaving
            // that to chance is exactly what made this test (and its
            // siblings below) intermittently flaky under load.
            client.close();
            vi.useRealTimers();
        });

        it("arms the reconnect backoff when the provider rejects, then connects once it recovers", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            let attempts = 0;
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: null }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
                wsToken: async () => {
                    attempts += 1;

                    if (attempts === 1) {
                        throw new Error("mint endpoint unreachable");
                    }

                    return "eph-recovered";
                },
            });

            client.subscribe(fnRef("__lunora_admin__:getMetrics"), {}, () => undefined);

            // First attempt: the provider rejects, so no socket is built.
            await vi.advanceTimersByTimeAsync(0);

            expect(sockets).toHaveLength(0);

            // The failure armed the normal reconnect backoff; the retry mints.
            await vi.advanceTimersByTimeAsync(15);

            expect(latestSocket().url).toContain("token=eph-recovered");

            // See the sibling test above — close before switching timer
            // modes so the fake-scheduled timers this client armed are
            // actually cancelled, not just abandoned.
            client.close();
            vi.useRealTimers();
        });
    });

    // --- getCurrentUser ---------------------------------------------------------

    describe("lunoraClient — getCurrentUser", () => {
        it("fetches better-auth get-session and returns the user, sending the bearer token", async () => {
            expect.assertions(4);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ session: { id: "s_1" }, user: { email: "a@b.co", id: "u_1" } }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("jwt-1");

            const user = await client.getCurrentUser();

            expect(user).toEqual({ email: "a@b.co", id: "u_1" });

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/api/auth/get-session");
            expect(init.method).toBe("GET");
            expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-1");
        });

        it("returns null when the session response has no user", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(async () => jsonResponse(null)),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.getCurrentUser()).resolves.toBeNull();
        });

        it("returns null on a non-OK response", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(async () => jsonResponse({}, { status: 401 })),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.getCurrentUser()).resolves.toBeNull();
        });

        it("returns null when the fetch rejects", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(async () => {
                    throw new Error("offline");
                }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await expect(client.getCurrentUser()).resolves.toBeNull();
        });

        it("honours a custom authBasePath", async () => {
            expect.assertions(1);

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ user: { id: "u_9" } }));

            const client = new LunoraClient({
                authBasePath: "/auth/",
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.getCurrentUser();

            const [requestUrl] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/auth/get-session");
        });
    });

    // --- Persistent read cache (Pillar 2) -----------------------------------

    describe("lunoraClient — persistent read cache", () => {
        it("hydrates a cached value and replays it to the first subscriber before any socket frame", async () => {
            expect.assertions(2);

            const cache = createInMemoryQueryCache();

            // Written while signed out (identity null) so it matches a signed-out client.
            await cache.put(queryCacheKey("messages:list", "{}"), { identity: null, serverCursor: 7, ts: 1, value: { count: 42 } });

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Let the constructor's hydrate microtask drain.
            await flushMicrotasks();

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            // The cached value is replayed synchronously — no socket frame yet.
            expect(received).toEqual([{ count: 42 }]);

            const socket = latestSocket();

            socket.open();

            // The subscribe frame carries the persisted cursor as `sinceSeq`.
            const sub = firstSub(socket);

            expect(sub.query.sinceSeq).toBe(7);
        });

        it("seeds the subscription that already exists when the cache load lands", async () => {
            expect.assertions(3);

            const cache = createInMemoryQueryCache();

            await cache.put(queryCacheKey("messages:list", "{}"), { identity: null, serverCursor: 7, ts: 1, value: { count: 42 } });

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            // Every framework adapter subscribes SYNCHRONOUSLY at mount — before
            // the constructor's hydration microtask + async adapter resolve.
            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            expect(received).toEqual([]);

            await flushMicrotasks();

            // The load reaches the subscription that is already open.
            expect(received).toEqual([{ count: 42 }]);

            const socket = latestSocket();

            socket.open();

            // …and its cursor still rides the subscribe frame, which only goes
            // out once the socket opens.
            expect(firstSub(socket).query.sinceSeq).toBe(7);
        });

        it("never replays a cached value over a newer live value on a remount", async () => {
            expect.assertions(2);

            const cache = createInMemoryQueryCache();

            await cache.put(queryCacheKey("messages:list", "{}"), { identity: null, serverCursor: 7, ts: 1, value: { count: 42 } });

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const unsubscribe = client.subscribe(fnRef("messages:list"), {}, () => undefined);

            await flushMicrotasks();

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ cursor: 9, data: { count: 99 }, id: sub.id, type: "data" });

            // The component unmounts (React drops the client state at refCount 0)
            // and remounts — navigate away and back.
            unsubscribe();

            const remounted: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => remounted.push(d));

            expect(remounted).toEqual([]);

            const resubscribe = wireFrames(latestSocket()).at(-1);

            expect(resubscribe?.query.sinceSeq).toBeUndefined();
        });

        it("drops a cached read whose identity does not match the current session", async () => {
            expect.assertions(1);

            const cache = createInMemoryQueryCache();

            // Cached under a different identity than the (signed-out) client.
            await cache.put(queryCacheKey("messages:list", "{}"), { identity: "other-user", serverCursor: 3, ts: 1, value: { count: 99 } });

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await flushMicrotasks();

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            // Mismatched identity ⇒ nothing replayed.
            expect(received).toEqual([]);
        });

        it("does not send sinceSeq on a cold subscription with no persisted cursor", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: createInMemoryQueryCache(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            expect(sub.query.sinceSeq).toBeUndefined();
        });

        it("keeps the cached value and acks on a resume frame without firing the callback again", async () => {
            expect.assertions(2);

            const cache = createInMemoryQueryCache();

            await cache.put(queryCacheKey("messages:list", "{}"), { identity: null, serverCursor: 7, ts: 1, value: { count: 42 } });

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await flushMicrotasks();

            const received: unknown[] = [];

            client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            // The server proves nothing changed since `sinceSeq` and resumes,
            // advancing the watermark to 9.
            socket.receive({ cursor: 9, id: sub.id, type: "resume" });

            // The callback fired once (the synchronous cached replay) and not again.
            expect(received).toEqual([{ count: 42 }]);

            // The advanced cursor is persisted (re-stamped onto the unchanged
            // value) so a later reconnect resumes from 9, not 7.
            client.close();

            await flushMicrotasks();

            const stored = await cache.load();

            expect(stored).toEqual([
                { identity: null, key: queryCacheKey("messages:list", "{}"), serverCursor: 9, ts: expect.any(Number), value: { count: 42 } },
            ]);
        });

        it("persists a query value (with its cursor) when a data frame advances it", async () => {
            expect.assertions(1);

            const cache = createInMemoryQueryCache();
            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ id: sub.id, type: "ack" });
            socket.receive({ cursor: 12, data: { count: 5 }, id: sub.id, type: "data" });

            // close() flushes the debounced read-cache write immediately.
            client.close();

            await flushMicrotasks();

            const stored = await cache.load();

            expect(stored).toEqual([
                { identity: null, key: queryCacheKey("messages:list", "{}"), serverCursor: 12, ts: expect.any(Number), value: { count: 5 } },
            ]);
        });

        it("a put that throws synchronously for one key does not drop the sibling writes", async () => {
            expect.assertions(1);

            const stored = new Map<string, CachedQuery>();
            const cache: QueryCacheAdapter = {
                clear: () => Promise.resolve(),
                load: () => Promise.resolve([]),
                put: (key, entry) => {
                    // A sync throw before any promise exists — the shape of
                    // structuredClone rejecting a non-cloneable value.
                    if (key.startsWith("bad:")) {
                        throw new Error("non-cloneable");
                    }

                    stored.set(key, entry);

                    return Promise.resolve();
                },
                remove: () => Promise.resolve(),
            };
            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("bad:list"), {}, () => undefined);
            client.subscribe(fnRef("good:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const [badSub, goodSub] = wireFrames(socket);

            socket.receive({ id: badSub.id, type: "ack" });
            socket.receive({ cursor: 1, data: { n: 1 }, id: badSub.id, type: "data" });
            socket.receive({ id: goodSub.id, type: "ack" });
            socket.receive({ cursor: 1, data: { n: 2 }, id: goodSub.id, type: "data" });

            // close() flushes both debounced writes in one batch; the throwing
            // key must not take the good one down with it.
            client.close();

            await flushMicrotasks();

            expect([...stored.keys()]).toEqual([queryCacheKey("good:list", "{}")]);
        });
    });

    describe("lunoraClient — whispering", () => {
        it("joins a topic, delivers inbound whispers, and broadcasts outbound ones", () => {
            expect.assertions(4);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const received: { data: unknown; from?: string }[] = [];
            const unsubscribe = client.whisperSubscribe("cursors", (data, from) => received.push({ data, from }));

            const socket = latestSocket();

            socket.open();

            // The join frame goes out on connect.
            expect(wireFrames(socket)).toContainEqual({ topic: "cursors", type: "whisper_subscribe" });

            // An inbound whisper reaches the handler with its `from`.
            socket.receive({ data: { x: 1 }, from: "user-b", topic: "cursors", type: "whisper" });

            expect(received).toEqual([{ data: { x: 1 }, from: "user-b" }]);

            // Outbound whisper is sent on the wire.
            client.whisper("cursors", { y: 2 });

            expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ data: { y: 2 }, topic: "cursors", type: "whisper" });

            // Last handler leaving the topic sends the leave frame.
            unsubscribe();

            expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ topic: "cursors", type: "whisper_unsubscribe" });
        });

        it("rejoins whisper topics after a reconnect", () => {
            expect.assertions(1);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.whisperSubscribe("cursors", () => undefined);

            const first = latestSocket();

            first.open();
            first.triggerClose();

            // Fire the scheduled reconnect timer (independent of the backoff
            // delay constant) so a fresh socket opens.
            vi.runOnlyPendingTimers();

            const second = latestSocket();

            second.open();

            expect(wireFrames(second)).toContainEqual({ topic: "cursors", type: "whisper_subscribe" });

            client.close();
        });
    });

    describe("lunoraClient — token expiry & resume epoch", () => {
        it("notifies onTokenExpired listeners when the server sends a TOKEN_EXPIRED error", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            let expired = 0;

            client.onTokenExpired(() => {
                expired += 1;
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);
            latestSocket().open();
            latestSocket().receive({ error: { code: "TOKEN_EXPIRED", message: "authentication token expired" }, type: "error" });

            expect(expired).toBe(1);
        });

        it("replays the resume epoch as sinceEpoch on reconnect", () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const first = latestSocket();

            first.open();
            const sub = firstSub(first);

            // A data frame stamped with cursor + epoch advances the resume position.
            first.receive({ cursor: 7, data: { count: 1 }, epoch: "epoch-abc", id: sub.id, type: "data" });

            first.triggerClose();
            // Fire the scheduled reconnect timer regardless of the backoff delay.
            vi.runOnlyPendingTimers();

            const second = latestSocket();

            second.open();

            const resub = firstSub(second);

            expect(resub.query.sinceSeq).toBe(7);
            expect(resub.query.sinceEpoch).toBe("epoch-abc");

            client.close();
        });
    });

    /**
     * The questions an adopter can't otherwise answer from outside the client: is the
     * socket open, what watermark has the server confirmed, has this subscription
     * been acked, is anything stuck in the queue.
     */
    describe("lunoraClient — debug snapshot", () => {
        it("reports an idle client before anything connects", () => {
            expect.assertions(4);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const snapshot = client.debug();

            expect(snapshot.connectionStatus).toBe("idle");
            expect(snapshot.shards).toStrictEqual([]);
            expect(snapshot.subscriptions).toStrictEqual([]);
            expect(snapshot.clientId).toEqual(expect.any(String));

            client.close();
        });

        it("reports the socket state, ack, and cursor of a live query subscription", () => {
            expect.assertions(6);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribe(fnRef("messages:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const sub = firstSub(socket);

            socket.receive({ cursor: 12, data: [], id: sub.id, type: "data" });

            const snapshot = client.debug();
            const subscription = snapshot.subscriptions[0];

            expect(snapshot.connectionStatus).toBe("connected");
            expect(snapshot.shards[0]?.wsState).toBe("open");
            expect(snapshot.shards[0]?.hasSocket).toBe(true);
            expect(subscription?.functionPath).toBe("messages:list");
            expect(subscription?.kind).toBe("query");
            expect(subscription?.serverCursor).toBe(12);

            client.close();
        });

        it("reports a shape subscription's rowset separately from queries", () => {
            expect.assertions(3);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.subscribeShape({ args: {}, name: "wholeOutline" }, () => undefined);

            const socket = latestSocket();

            socket.open();

            const snapshot = client.debug();
            const shape = snapshot.subscriptions.find((entry) => entry.kind === "shape");

            // Named `shape:<name>` so a mixed list stays readable at a glance.
            expect(shape?.functionPath).toBe("shape:wholeOutline");
            expect(shape?.rowCount).toBe(0);
            expect(shape?.subscriberCount).toBe(1);

            client.close();
        });

        it("surfaces the confirmed per-shard mutation watermark", async () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 4, result: null })),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.callMutator("mutators:send", {}, { clientSeq: 1, shardKey: "user-1" });

            const shard = client.debug().shards.find((entry) => entry.shardKey === "user-1");

            // The single most useful number when an overlay won't clear: what the
            // server has actually confirmed for this client on this shard.
            expect(shard?.confirmedMutationWatermark).toBe(4);
            expect(shard?.wsState).toBe("idle");

            client.close();
        });

        it("reports a closed client", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: vi.fn<typeof fetch>(),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.close();

            expect(client.debug().closed).toBe(true);
        });
    });

    // --- Bulk import --------------------------------------------------------------

    describe("lunoraClient — importRows", () => {
        /**
         * Run `importRows` against a fetch mock that records, per chunk, the
         * `x-lunora-mutation-id` idempotency key and the rows that chunk carried.
         * Returns a `key → JSON(rows)` map so a resume can be checked for aliasing.
         */
        const runImport = async (
            rows: ReadonlyArray<unknown>,
            options: { chunkSize: number; importId: string },
        ): Promise<{ keyToRows: Map<string, string>; result: { chunks: number; imported: number } }> => {
            const keyToRows = new Map<string, string>();

            const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
                const request = init as RequestInit;
                const key = (request.headers as Record<string, string>)["x-lunora-mutation-id"] ?? "<missing>";
                const body = JSON.parse(request.body as string) as { args: { rows: unknown[] } };

                keyToRows.set(key, JSON.stringify(body.args.rows));

                return jsonResponse({ result: null });
            });

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.importRows(fnRef("migrate:importRows"), rows, options);

            client.close();

            return { keyToRows, result };
        };

        it("chunks the rows, reports progress, and returns the imported count", async () => {
            expect.assertions(4);

            const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }];
            const progress: { done: number; total: number }[] = [];

            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: null }));
            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.importRows(fnRef("migrate:importRows"), rows, {
                chunkSize: 2,
                onProgress: (p) => progress.push(p),
            });

            expect(result).toEqual({ chunks: 3, imported: 5 });
            // 5 rows / chunkSize 2 → 3 POSTs (2 + 2 + 1).
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(progress).toEqual([
                { done: 2, total: 5 },
                { done: 4, total: 5 },
                { done: 5, total: 5 },
            ]);

            // The last chunk carried the tail row only.
            const lastBody = JSON.parse((fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit])[1].body as string) as {
                args: { rows: unknown[] };
            };

            expect(lastBody.args.rows).toEqual([{ id: 5 }]);
        });

        it("keys each chunk under the importId-plus-index form so a retry dedupes server-side", async () => {
            expect.assertions(1);

            const { keyToRows } = await runImport([{ id: 1 }, { id: 2 }, { id: 3 }], { chunkSize: 2, importId: "imp" });

            expect([...keyToRows.keys()]).toEqual(["imp:0", "imp:1"]);
        });

        // Resume-safety: this asserts the CORRECT behavior and is EXPECTED TO FAIL against
        // the current position-based idempotency key (importId plus chunk index). When a
        // resume uses a different `chunkSize`, the same key aliases different content, so the
        // server dedupes and silently drops rows. `it.fails` keeps the suite green while
        // pinning the bug; it flips to a real failure (prompting an un-skip) once the client
        // importRows content-key fix lands. See the plans index (plan 192 depends on that fix).
        it.fails("does not reuse a mutation key for differently-chunked content across a resume", async () => {
            expect.hasAssertions();

            const rows = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];

            const first = await runImport(rows, { chunkSize: 2, importId: "imp" });
            const resumed = await runImport(rows, { chunkSize: 1, importId: "imp" });

            // A key that appears in both runs must carry identical content in both —
            // otherwise the resume's chunk is deduped away against the first run's. Collect
            // every aliasing key so the single assertion lives outside the loop.
            const aliasedKeys = [...resumed.keyToRows]
                .filter(([key, content]) => first.keyToRows.has(key) && first.keyToRows.get(key) !== content)
                .map(([key]) => key);

            expect(aliasedKeys).toEqual([]);
        });
    });

    // --- Log archive --------------------------------------------------------------

    describe("lunoraClient — queryLogArchive", () => {
        it("pOSTs the query to the admin archive endpoint and returns rows + cursor", async () => {
            expect.assertions(4);

            const page = { nextCursor: { ts: 1_699_999_000_000 }, rows: [{ functionPath: "messages:list", level: "error", message: "boom", ts: 1 }] };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(page));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.queryLogArchive({ level: "error" });

            expect(result).toEqual(page);

            const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];

            expect(requestUrl).toBe("https://app.example/_lunora/admin/logs/archive");
            expect(init.method).toBe("POST");
            expect(JSON.parse(init.body as string)).toEqual({ level: "error" });
        });

        it("round-trips the opaque cursor back into the next page's request body", async () => {
            expect.assertions(1);

            const cursor = { shard: "user-1", ts: 42 };
            const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ rows: [] }));

            const client = new LunoraClient({
                fetch: fetchMock,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.queryLogArchive({ cursor });

            const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];

            // The cursor is passed through unchanged — the client never inspects it.
            expect(JSON.parse(init.body as string)).toEqual({ cursor });
        });

        it("defaults to an empty rows array (and no cursor) when the worker omits them", async () => {
            expect.assertions(2);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({}),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            const result = await client.queryLogArchive();

            expect(result.rows).toEqual([]);
            expect(result.nextCursor).toBeUndefined();
        });
    });

    // --- Audit regressions ------------------------------------------------------

    describe("lunoraClient — reconnect backoff resets on proof of life, not on `open`", () => {
        it("backs off across repeated open→TOKEN_EXPIRED→close cycles instead of retrying at the initial delay forever", async () => {
            expect.assertions(4);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                reconnect: { initialDelayMs: 100, jitter: false },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.subscribe(fnRef("q:list"), {}, () => undefined);

                expect(sockets).toHaveLength(1);

                // What an expired credential actually looks like: the server accepts
                // the UPGRADE, then rejects the first frame and closes with 4001.
                const expire = (): void => {
                    const socket = latestSocket();

                    socket.open();
                    socket.receive({ error: { code: "TOKEN_EXPIRED", message: "authentication token expired" }, type: "error" });
                    socket.triggerClose();
                };

                expire();
                await vi.advanceTimersByTimeAsync(100);

                expect(sockets).toHaveLength(2);

                expire();
                // The second attempt owes 200ms. Resetting on `open` made every
                // attempt owe the initial 100ms forever — a ~4-8 upgrades/sec storm.
                await vi.advanceTimersByTimeAsync(100);

                expect(sockets).toHaveLength(2);

                await vi.advanceTimersByTimeAsync(100);

                expect(sockets).toHaveLength(3);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        });

        it("does reset the backoff once a non-error frame proves the socket is live", async () => {
            expect.assertions(2);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                reconnect: { initialDelayMs: 100, jitter: false },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.subscribe(fnRef("q:list"), {}, () => undefined);
                latestSocket().open();
                latestSocket().triggerClose();

                await vi.advanceTimersByTimeAsync(100);

                expect(sockets).toHaveLength(2);

                const socket = latestSocket();

                socket.open();
                socket.receive({ id: firstSub(socket).id as string, type: "ack" });
                socket.triggerClose();

                // The ack proved the socket usable, so the backoff restarts at the
                // initial delay rather than doubling to 200ms.
                await vi.advanceTimersByTimeAsync(100);

                expect(sockets).toHaveLength(3);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        });
    });

    describe("lunoraClient — the read cache is stamped with the delivering socket's identity", () => {
        it("does not write the previous user's rows under the new user's identity after a switch", async () => {
            expect.assertions(2);

            const cache = createInMemoryQueryCache();
            const puts: CachedQuery[] = [];
            const recording: QueryCacheAdapter = {
                clear: cache.clear,
                load: cache.load,
                put: async (key, entry) => {
                    puts.push(entry);

                    return cache.put(key, entry);
                },
                remove: cache.remove,
            };

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                queryCache: recording,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            client.setAuthToken("token-a", "user-a");

            const identityA = client.currentIdentity();

            client.subscribe(fnRef("q:list"), {}, () => undefined);

            const socket = latestSocket();

            socket.open();

            const subId = firstSub(socket).id as string;

            // The user switches. Nothing closes user A's socket — the WS credential
            // is pinned in the upgrade URL and only `setWsToken` bounces it.
            client.setAuthToken("token-b", "user-b");

            expect(client.currentIdentity()).not.toBe(identityA);

            // ...and it keeps delivering user A's rows.
            socket.receive({ cursor: 1, data: ["a-row"], id: subId, type: "data" });

            // `close()` flushes the debounced cache writes.
            client.close();
            await flushMicrotasks();

            expect(puts.map((entry) => entry.identity)).toStrictEqual([identityA]);
        });
    });

    describe("lunoraClient — a re-stamped offline write keeps its new identity durably", () => {
        it("rewrites the persisted record when a subject resolves on an unchanged token", async () => {
            expect.assertions(3);

            const persistence = createInMemoryPersistence();
            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                offlineQueue: { queueBeforeFirstConnect: true },
                persistence,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.setAuthToken("token-1");

                const tokenIdentity = client.currentIdentity();

                // Queued while offline, stamped with the token hash (no subject yet).
                client.mutation(fnRef("m:add"), { n: 1 }).catch(() => undefined);
                await flushMicrotasks();

                const before = await persistence.load();

                expect(before.map((record) => record.identity)).toStrictEqual([tokenIdentity]);

                // The user id resolves a tick later on the SAME credential — the
                // sticky-`subject` re-stamp `setAuthToken` documents.
                client.setAuthToken("token-1", "user-1");
                await flushMicrotasks();

                const subjectIdentity = client.currentIdentity();

                expect(subjectIdentity).not.toBe(tokenIdentity);

                const after = await persistence.load();

                // Without the durable half of the re-stamp this record still carried
                // the old token hash, so a reload (or a requeue after the token had
                // since refreshed) rejected the same user's write as
                // OFFLINE_IDENTITY_CHANGED.
                expect(after.map((record) => record.identity)).toStrictEqual([subjectIdentity]);
            } finally {
                client.close();
            }
        });
    });

    describe("lunoraClient — a torn-down connection settles the streams it was carrying", () => {
        it("fails an in-flight stream when cross-tab leadership is lost instead of hanging its consumer", async () => {
            expect.assertions(3);

            vi.useFakeTimers();
            sockets.length = 0;

            const client = new LunoraClient({
                crossTabSync: true,
                fetch: async () => jsonResponse({ result: {} }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.subscribe(fnRef("q:list"), {}, () => undefined);

                // Solo self-promotion (default 3s leaderTimeout) opens the socket.
                await vi.advanceTimersByTimeAsync(3100);

                expect(sockets).toHaveLength(1);

                sockets[0]?.open();

                const iterable = client.stream(fnRef("s:tail") as FunctionReference<"stream">, {});

                let outcome = "pending";
                const drained: unknown[] = [];
                const consumer = (async () => {
                    try {
                        for await (const chunk of iterable) {
                            drained.push(chunk);
                        }

                        outcome = "completed";
                    } catch (error: unknown) {
                        outcome = (error as Error).message;
                    }
                })();

                // An identity change stops the coordinator, and a leader that stops
                // fires `onStopBeingLeader` → `teardownConnection`. That clears
                // `conn.socket` before the real `close` event lands, so the close
                // listener trips its identity guard and `handleDisconnect` — the only
                // other place that settles a shard's streams — never runs.
                client.setAuthToken("token-1", "user-1");
                await vi.advanceTimersByTimeAsync(10);

                expect(outcome).toContain("torn down");

                await consumer;

                // The teardown settles the stream by failing it, so the consumer
                // never saw a frame — it must not have silently completed empty.
                expect(drained).toHaveLength(0);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        });
    });

    describe("lunoraClient — close() stops the scheduled-jobs admin socket", () => {
        it("closes the socket and stops its reconnect loop", async () => {
            expect.assertions(3);

            vi.useFakeTimers();

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                reconnect: { initialDelayMs: 50, jitter: false },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                client.subscribeScheduledJobs(() => undefined);

                expect(sockets).toHaveLength(1);

                const socket = latestSocket();

                socket.open();
                client.close();

                // Its `closed` flag is closure-local, so nothing outside the returned
                // unsubscribe used to reach it: the socket stayed open and its backoff
                // loop kept reconnecting (re-minting a `WsTokenProvider` sub-token on
                // every attempt) after the client was dead.
                expect(socket.readyState).toBe(3);

                await vi.advanceTimersByTimeAsync(500);

                expect(sockets).toHaveLength(1);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    describe("lunoraClient — a fresh write waits behind the post-reconnect replay", () => {
        it("does not let a mutation issued during the flush overtake the queued write it must follow", async () => {
            expect.assertions(5);

            vi.useFakeTimers();

            const deferreds: ((value: Response) => void)[] = [];
            const fetchMock = vi.fn<typeof fetch>(
                async () =>
                    new Promise<Response>((resolve) => {
                        deferreds.push(resolve);
                    }),
            );
            const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

            try {
                client.subscribe(fnRef("q:list"), {}, () => undefined);

                const first = latestSocket();

                first.open();
                first.triggerClose();

                client.mutation(fnRef("m:edit"), { v: 1 }).catch(() => undefined);
                await vi.advanceTimersByTimeAsync(0);

                expect(fetchMock).toHaveBeenCalledTimes(0);

                await vi.advanceTimersByTimeAsync(600);

                expect(sockets).toHaveLength(2);

                latestSocket().open();
                await vi.advanceTimersByTimeAsync(0);

                // The queued write is replaying.
                expect(fetchMock).toHaveBeenCalledTimes(1);

                // `onOpen` flips `wsState` to "open" before it starts the flush, so
                // this write's offline gate is already false — it used to race the
                // replay straight to /rpc, and if it landed first the older write
                // overwrote it.
                client.mutation(fnRef("m:edit"), { v: 2 }).catch(() => undefined);
                await vi.advanceTimersByTimeAsync(0);

                expect(fetchMock).toHaveBeenCalledTimes(1);

                deferreds[0]?.(jsonResponse({ commitCursor: 1, result: { ok: true } }));
                await vi.advanceTimersByTimeAsync(1);

                expect(fetchMock).toHaveBeenCalledTimes(2);
            } finally {
                client.close();
                vi.useRealTimers();
            }
        });
    });

    describe("lunoraClient — close() releases the registries its comment claims", () => {
        it("drops subscriptions, client-query subscribers and the hydrated read cache", async () => {
            expect.assertions(4);

            const cache = createInMemoryQueryCache();

            await cache.put(queryCacheKey("q:seeded", "{}"), { identity: null, ts: Date.now(), value: ["seed"] });

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                queryCache: cache,
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            await client.whenReady();

            const slot = createClientQuery("counter", 0);

            client.subscribe(fnRef("q:list"), {}, () => undefined);
            client.subscribeClientQuery(slot, () => undefined);

            // No public surface reports retained closures, so read the registries a
            // React state setter would otherwise be pinned in.
            const internals = client as unknown as {
                clientQueryStore: { subscribe: (reference: unknown, callback: unknown) => () => void };
                hydratedQueryCache: Map<string, unknown>;
                subscriptions: { all: () => unknown[] };
            };
            const { subscribers } = (client as unknown as { clientQueryStore: { subscribers: Map<string, Set<unknown>> } }).clientQueryStore;

            expect(internals.subscriptions.all()).toHaveLength(1);
            expect(subscribers.size).toBe(1);

            client.close();

            expect(internals.subscriptions.all()).toHaveLength(0);
            expect(internals.hydratedQueryCache.size).toBe(0);
        });
    });

    describe("lunoraClient — the settled watermark is monotonic", () => {
        it("ignores a lower lastMutationId after the server's watermark row resets", () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ result: {} }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                const checkpoints: { mutationId?: number }[] = [];

                client.subscribe(fnRef("q:list"), {}, () => undefined, { onCheckpoint: (watermark) => checkpoints.push(watermark) });

                const socket = latestSocket();

                socket.open();

                const subId = firstSub(socket).id as string;

                socket.receive({ cursor: 1, id: subId, lastMutationId: 5, type: "settled" });
                // A recycled DO / PITR restore restarts the watermark row lower.
                socket.receive({ cursor: 2, id: subId, lastMutationId: 3, type: "settled" });

                expect(checkpoints.map((watermark) => watermark.mutationId)).toStrictEqual([5, 5]);
            } finally {
                client.close();
            }
        });
    });

    describe("lunoraClient — deleteStorageObject defaults to failure", () => {
        it("reports `deleted: false` when the worker omits the field", async () => {
            expect.assertions(1);

            const client = new LunoraClient({
                fetch: async () => jsonResponse({ key: "a.txt" }),
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

            try {
                // Every sibling admin verb defaults an absent field to failure; the
                // studio renders this value as the row's outcome.
                await expect(client.deleteStorageObject("a.txt")).resolves.toStrictEqual({ deleted: false, key: "a.txt" });
            } finally {
                client.close();
            }
        });
    });
});
