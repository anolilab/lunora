import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_BATCH_ENTRIES } from "../../../shared/batch-wire";
import type { AsyncStorageLike } from "../src/async-storage-persistence";
import { createAsyncStoragePersistence } from "../src/async-storage-persistence";
import { isConflictError } from "../src/errors";
import { LunoraClient } from "../src/lunora-client";
import { createIndexedDbQueryCache, queryCacheKey } from "../src/query-cache";
import type { FunctionReference } from "../src/types";

/**
 * End-to-end offline lifecycle tests — the named gap from the local-first plan
 * (Pillar 4). Each test drives the *real* durable adapters (a fake AsyncStorage
 * / `fake-indexeddb`) through a full reload boundary against a mock socket,
 * exercising the seams the per-module suites mock out: outbox durability across
 * a relaunch (Pillar 1a), read hydration from disk (Pillar 2), resume-from-cursor
 * on reconnect (Pillar 1b), optimistic rollback on a coded conflict, and the
 * identity trust boundary between sessions.
 */

const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

/**
 * Drain several macrotask ticks. `fake-indexeddb` resolves an open + `getAll`
 * over a handful of ticks, so a single flush isn't enough to guarantee the
 * client's async cache hydration has landed before we read it.
 */
const settleIndexedDb = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of IDB ticks
        await flushMicrotasks();
    }
};

// --- Mock socket harness ----------------------------------------------------

interface MockSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

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

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.triggerClose();
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
 * The first subscribe frame a socket sent, past the always-first `connect`
 * lifecycle envelope (the client announces every socket on open so `onConnect`
 * fires symmetrically with `onDisconnect`).
 */
const firstSub = (socket: MockSocket) => socket.sent.map((raw) => JSON.parse(raw)).find((frame) => frame.type === "subscribe");

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, {
        headers: { "content-type": "application/json" },
        status: 200,
        ...init,
    });

/** A `Map`-backed stand-in for React Native's async key/value store. */
const createFakeAsyncStorage = (): AsyncStorageLike => {
    const store = new Map<string, string>();

    return {
        getItem: (key) => Promise.resolve(store.get(key) ?? null),
        removeItem: (key) => {
            store.delete(key);

            return Promise.resolve();
        },
        setItem: (key, value) => {
            store.set(key, value);

            return Promise.resolve();
        },
    };
};

/** Read the headers map passed to a recorded `fetch` call. */
const headersOf = (call: Parameters<typeof fetch>): Record<string, string> => (call[1]?.headers ?? {}) as Record<string, string>;

describe("offline lifecycle (e2e)", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("1. enqueues offline, survives a reload, and flushes exactly once with a stable idempotency key", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));
        const storage = createFakeAsyncStorage();

        // --- Session A: come online, drop offline, queue a write -------------
        const clientA = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: createAsyncStoragePersistence({ storage }),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        clientA.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // Issued while offline → queued, never sent.
        clientA.mutation(fnRef("posts:create"), { title: "queued" }).catch(() => undefined);
        await vi.advanceTimersByTimeAsync(0);

        const persisted = await createAsyncStoragePersistence({ storage }).load();

        expect(persisted).toHaveLength(1);
        expect(fetchMock).not.toHaveBeenCalled();

        clientA.close();

        // --- Session B: relaunch over the same durable store ----------------
        const clientB = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: createAsyncStoragePersistence({ storage }),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        // Hydration opens a socket for the restored write's shard.
        await vi.advanceTimersByTimeAsync(0);
        latestSocket().open();
        await vi.runAllTimersAsync();

        // The server saw the write once, carrying the same idempotency key the
        // first session minted — a server-side dedup makes a retry a no-op.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(headersOf(fetchMock.mock.calls[0]!)["x-lunora-mutation-id"]).toBe(persisted[0]!.id);

        clientB.close();
    });

    it("2. serves a query from disk while offline (no socket frame)", async () => {
        expect.assertions(2);

        const indexedDB = new IDBFactory();

        // A prior session persisted this read to disk.
        const priorCache = createIndexedDbQueryCache({ indexedDB });

        await priorCache.put(queryCacheKey("messages:list", "{}"), {
            identity: null,
            serverCursor: 5,
            ts: 1,
            value: [{ _id: "a", text: "from disk" }],
        });

        // --- Reload: a fresh client + cache handle over the same store -------
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(),
            queryCache: createIndexedDbQueryCache({ indexedDB }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        await settleIndexedDb();

        const received: unknown[] = [];

        client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

        // Rendered from disk before any socket frame — the offline read path.
        expect(received).toEqual([[{ _id: "a", text: "from disk" }]]);

        // The subscribe frame asks the server to resume from the cached cursor.
        latestSocket().open();
        const sub = firstSub(latestSocket());

        expect(sub.query.sinceSeq).toBe(5);

        client.close();
    });

    it("3. resumes from the persisted cursor on reconnect (deltas, not a snapshot)", () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(),
            heartbeatIntervalMs: 0,
            queryCache: createIndexedDbQueryCache({ indexedDB: new IDBFactory() }),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("messages:list"), {}, () => undefined);

        const first = latestSocket();

        first.open();

        const sub1 = firstSub(first);

        // Cold subscription — no cursor to resume from yet.
        expect(sub1.query.sinceSeq).toBeUndefined();

        first.receive({ id: sub1.id, type: "ack" });
        first.receive({ cursor: 21, data: [{ _id: "a" }], id: sub1.id, type: "data" });

        // Drop the socket and let the reconnect timer fire.
        first.triggerClose();
        vi.advanceTimersByTime(20);

        const second = latestSocket();

        second.open();

        const sub2 = firstSub(second);

        // The re-subscribe carries the last server cursor as `sinceSeq`, so the
        // server replays only the deltas since 21 instead of a full snapshot.
        expect(sub2.query.sinceSeq).toBe(21);

        client.close();
    });

    it("4. rolls the optimistic value back when the server rejects with a coded conflict", async () => {
        expect.assertions(3);

        const fetchMock = vi.fn<typeof fetch>(async () =>
            jsonResponse({ error: { code: "CONFLICT", message: "optimistic concurrency conflict" } }, { status: 409 }),
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

        const sub = firstSub(socket);

        socket.receive({ delta: 5, id: sub.id, type: "delta" });

        expect(received).toEqual([5]);

        const error = await client.mutation(fnRef("counter:get"), {}, { optimistic: (current) => (typeof current === "number" ? current + 1 : 1) }).then(
            () => null,
            (error_: unknown) => error_,
        );

        // A coded conflict is surfaced (not swallowed)…
        expect(isConflictError(error)).toBe(true);
        // …and the optimistic bump was rolled back to the server value.
        expect(received).toEqual([5, 6, 5]);

        client.close();
    });

    it("6. keeps a write persisted and retries when replay hits a transient transport error", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const storage = createFakeAsyncStorage();

        // A durable write left by a prior signed-out session.
        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "durable" },
            functionPath: "posts:create",
            id: "m1",
            identity: null,
        });

        let attempt = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            attempt += 1;

            // First replay: the network dropped mid-flight. A transport error
            // carries no server `code`, so the write must survive for a retry.
            if (attempt === 1) {
                throw new TypeError("Failed to fetch");
            }

            return jsonResponse({ result: { id: "m1" } });
        });

        const makeClient = (): LunoraClient =>
            new LunoraClient({
                fetch: fetchMock,
                heartbeatIntervalMs: 0,
                persistence: createAsyncStoragePersistence({ storage }),
                reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
                url: "https://app.example",
                WebSocket: createMockWebSocket(),
            });

        // --- Session A: hydration opens a socket → first flush fails transiently
        const clientA = makeClient();

        await vi.advanceTimersByTimeAsync(0);
        latestSocket().open();
        await vi.runAllTimersAsync();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toHaveLength(1);

        clientA.close();

        // --- Session B: relaunch retries the still-durable write to success ---
        const clientB = makeClient();

        await vi.advanceTimersByTimeAsync(0);
        latestSocket().open();
        await vi.runAllTimersAsync();

        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        clientB.close();
    });

    it("7. surfaces a hydrated write's coded rejection on onMutationSettled (no live awaiter)", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const storage = createFakeAsyncStorage();

        // A durable write left by a prior session — its original `mutation()`
        // Promise is long gone after the reload.
        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "durable" },
            functionPath: "posts:create",
            id: "m1",
            identity: null,
        });

        // The server now rejects the replay with a coded error (e.g. the row was
        // deleted server-side). Without the observer this is silently dropped.
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ error: { code: "CONFLICT", message: "row no longer exists" } }, { status: 409 }));

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: createAsyncStoragePersistence({ storage }),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const settled: { code?: string; functionPath: string; hadAwaiter: boolean; status: string }[] = [];

        client.onMutationSettled((event) => settled.push(event));

        // Hydration opens a socket for the restored write's shard → flush.
        await vi.advanceTimersByTimeAsync(0);
        latestSocket().open();
        await vi.runAllTimersAsync();

        expect(settled).toHaveLength(1);
        expect(settled[0]?.status).toBe("rejected");
        expect(settled[0]?.code).toBe("CONFLICT");
        // The decisive bit: a post-reload replay has no awaiter, so this observer
        // is the ONLY channel that can tell the UI the write was dropped.
        expect(settled[0]?.hadAwaiter).toBe(false);
        // The poison write is purged from durable storage (no replay loop).
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        client.close();
    });

    it("8. surfaces a committed flush and a live-awaiter rejection on onMutationSettled", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const storage = createFakeAsyncStorage();
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "1" } }));

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: createAsyncStoragePersistence({ storage }),
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const settled: { hadAwaiter: boolean; status: string }[] = [];

        client.onMutationSettled((event) => settled.push(event));

        // Connect once, drop offline, then queue a write with a live awaiter.
        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fnRef("posts:create"), { title: "queued" }).catch(() => undefined);

        await vi.advanceTimersByTimeAsync(0);

        // Fire the reconnect timer so a fresh socket is created, then open it →
        // flush → commit. (Opening stops the reconnect loop.)
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);
        await pending;

        expect(settled).toHaveLength(1);
        expect(settled[0]?.status).toBe("committed");
        // A live caller was awaiting this write's Promise.
        expect(settled[0]?.hadAwaiter).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        client.close();
    });

    it("5. drops cached reads and queued writes from a different identity across sessions", async () => {
        expect.assertions(3);

        const indexedDB = new IDBFactory();
        const storage = createFakeAsyncStorage();
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));

        // A prior, signed-in session left both a cached read and a queued write
        // stamped with its identity fingerprint.
        await createIndexedDbQueryCache({ indexedDB }).put(queryCacheKey("messages:list", "{}"), {
            identity: "12:userastamp",
            serverCursor: 9,
            ts: 1,
            value: [{ _id: "secret" }],
        });
        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "user-a" },
            functionPath: "posts:create",
            id: "m1",
            identity: "12:userastamp",
        });

        // --- Reload as a different (here: signed-out) identity ---------------
        const client = new LunoraClient({
            fetch: fetchMock,
            persistence: createAsyncStoragePersistence({ storage }),
            queryCache: createIndexedDbQueryCache({ indexedDB }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        await flushMicrotasks();

        const received: unknown[] = [];

        client.subscribe(fnRef("messages:list"), {}, (d) => received.push(d));

        // The cached read is not replayed under the new identity.
        expect(received).toEqual([]);

        // Let any hydrated-write flush attempt settle.
        latestSocket().open();
        await flushMicrotasks();

        // The queued write is dropped, not replayed under the new identity, and
        // is purged from durable storage.
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        client.close();
    });

    it("10. coalesces a multi-write outbox flush into ONE rpc-batch round trip (plan 088 follow-on)", async () => {
        expect.assertions(7);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async (input) => {
            const url = input as string;

            // The whole point: the flush of N same-shard writes hits the batch
            // endpoint once, not the single-call endpoint N times.
            if (url.endsWith("/_lunora/rpc-batch")) {
                return jsonResponse({
                    results: [
                        { body: { commitCursor: 101, result: { id: "a" } }, id: 0 },
                        { body: { commitCursor: 102, result: { id: "b" } }, id: 1 },
                        { body: { commitCursor: 103, result: { id: "c" } }, id: 2 },
                    ],
                });
            }

            throw new Error(`unexpected single-call fetch to ${url}`);
        });

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        // Connect once (so writes queue rather than throw), then drop offline.
        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // Three writes to the same (default) shard queue up while offline.
        const pending = Promise.all([
            client.mutation(fnRef("posts:create"), { title: "a" }),
            client.mutation(fnRef("posts:create"), { title: "b" }),
            client.mutation(fnRef("posts:create"), { title: "c" }),
        ]);

        await vi.advanceTimersByTimeAsync(0);

        // Reconnect → flush.
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const results = await pending;

        // ONE request, to the batch endpoint, carrying all three writes...
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0]![0] as string).endsWith("/_lunora/rpc-batch")).toBe(true);

        const sentCalls = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string).calls as {
            clientId?: string;
            functionPath: string;
            id: number;
            mutationId?: string;
        }[];

        expect(sentCalls).toHaveLength(3);
        // ...each carrying a stable per-write idempotency key (id)...
        expect(sentCalls.every((call) => typeof call.mutationId === "string" && call.mutationId.length > 0)).toBe(true);
        // ...paired with the client id that issued it. The shard namespaces an
        // ANONYMOUS caller's `__idempotency` row by this; a batch entry without one
        // has no namespace, so the DO skips dedup and a replayed write RE-RUNS.
        expect(sentCalls.every((call) => typeof call.clientId === "string" && call.clientId.length > 0)).toBe(true);
        // ...and every caller's Promise resolves with its own demuxed result.
        expect(results).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }]);
        // FIFO order preserved in the request.
        expect(sentCalls.map((call) => call.id)).toEqual([0, 1, 2]);

        client.close();
    });

    it("11. chunks an over-cap outbox flush into multiple batch requests (no write dropped)", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        // More writes than fit in one batch — the flush must split into
        // cap-sized requests, not send one over-cap batch the worker would reject
        // wholesale (which would drop every durable write).
        const total = MAX_BATCH_ENTRIES + 2;
        const batchSizes: number[] = [];

        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            if (!(input as string).endsWith("/_lunora/rpc-batch")) {
                throw new Error(`unexpected single-call fetch to ${input as string}`);
            }

            const { calls } = JSON.parse((init as RequestInit).body as string) as { calls: { id: number }[] };

            batchSizes.push(calls.length);

            return jsonResponse({
                results: calls.map((call) => {
                    return { body: { result: { ok: true } }, id: call.id };
                }),
            });
        });

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = Promise.all(Array.from({ length: total }, (_, index) => client.mutation(fnRef("posts:create"), { index })));

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const results = await pending;

        // Split into ceil(total / cap) = 2 requests, none over the cap...
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(Math.max(...batchSizes)).toBeLessThanOrEqual(MAX_BATCH_ENTRIES);
        // ...every write was sent exactly once (none dropped)...
        expect(batchSizes.reduce((sum, size) => sum + size, 0)).toBe(total);
        // ...and every caller's Promise resolved.
        expect(results).toHaveLength(total);

        client.close();
    });

    it("12. rejects a queued write with un-encodable args instead of hanging the flush", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // A RegExp can't be wire-encoded (only reachable via a `v.any()` arg). The
        // write queues offline; on flush its encode is a DETERMINISTIC failure, so it
        // must reject terminally, not re-queue forever (a silent hang).
        const bad = client.mutation(fnRef("posts:create"), { pattern: /abc/g });
        const settled = bad.then(
            () => "resolved",
            (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const result = await settled;

        // The caller's Promise rejects with the codec error — no hang, no send.
        expect(result).toBeInstanceOf(TypeError);
        expect((result as Error).message).toMatch(/RegExp|encode/);
        expect(fetchMock).not.toHaveBeenCalled();

        client.close();
    });

    it("13. rejects a queued write whose precondition fails before replay (no hang)", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));
        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // Queued offline with a precondition that no longer holds at replay time.
        // On flush `drainConflict()` drops it, so the awaiting caller must reject
        // terminally (not hang forever with an un-run optimistic rollback).
        const stale = client.mutation(fnRef("posts:create"), { title: "stale" }, { precondition: () => false });
        const settled = stale.then(
            () => "resolved",
            (error: unknown) => error,
        );

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const result = await settled;

        expect(result).toBeInstanceOf(Error);
        expect((result as Error & { code?: string }).code).toBe("OFFLINE_PRECONDITION_FAILED");
        expect(fetchMock).not.toHaveBeenCalled();

        client.close();
    });

    it("9. drops and purges a persisted write whose schema version no longer matches", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const storage = createFakeAsyncStorage();

        // A durable write left by an OLDER app version (stamped "v1").
        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "old-build" },
            functionPath: "posts:create",
            id: "m1",
            identity: null,
            version: "v1",
        });

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { id: "m1" } }));

        // The new build runs persistenceVersion "v2".
        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            persistence: createAsyncStoragePersistence({ storage }),
            persistenceVersion: "v2",
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        await vi.runAllTimersAsync();

        // The stale-version write is NOT replayed against the new schema...
        expect(fetchMock).not.toHaveBeenCalled();
        // ...and is purged from durable storage.
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        client.close();
    });
});
