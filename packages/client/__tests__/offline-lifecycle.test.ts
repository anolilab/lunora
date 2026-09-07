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

    it("5. HOLDS a queued write across a reload whose session has not resolved yet, then replays it once the token lands", async () => {
        expect.assertions(6);

        const indexedDB = new IDBFactory();
        const storage = createFakeAsyncStorage();
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));

        // A prior, signed-in session left both a cached read and a queued write
        // stamped with its identity fingerprint.
        await createIndexedDbQueryCache({ indexedDB }).put(queryCacheKey("messages:list", "{}"), {
            identity: "subj:user-a",
            serverCursor: 9,
            ts: 1,
            value: [{ _id: "secret" }],
        });
        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "user-a" },
            functionPath: "posts:create",
            id: "m1",
            identity: "subj:user-a",
        });

        // --- Reload: the socket opens BEFORE the app resolves its session ----
        // The durable replay starts in the constructor; `setAuthToken` lands a
        // tick later, once the app's own token read resolves. Signed-out is the
        // normal state of EVERY reload up to that point — not a different user.
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

        // The cached read is not surfaced to a session with no resolved identity.
        expect(received).toEqual([]);

        latestSocket().open();
        await settleIndexedDb();

        // The write is HELD, not replayed and not purged: there is no other
        // identity to replay it as, so dropping here would destroy the queuing
        // user's own offline write, irreversibly.
        expect(fetchMock).not.toHaveBeenCalled();
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toHaveLength(1);

        // --- The app's session resolves — as the SAME user -------------------
        client.setAuthToken("token-a", "user-a");
        await settleIndexedDb();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined)?.body ?? "{}")).toMatchObject({ args: { title: "user-a" } });
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        client.close();
    });

    it("5b. drops (and purges) a queued write stamped by a DIFFERENT signed-in identity", async () => {
        expect.assertions(3);

        const storage = createFakeAsyncStorage();
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));

        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "user-a" },
            functionPath: "posts:create",
            id: "m1",
            identity: "subj:user-a",
        });

        const client = new LunoraClient({
            fetch: fetchMock,
            persistence: createAsyncStoragePersistence({ storage }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const settled: string[] = [];

        client.onMutationSettled((event) => settled.push(event.status));

        // Let the durable queue hydrate, then sign in as a genuinely different
        // user and open the socket so the replay runs.
        await flushMicrotasks();

        client.setAuthToken("token-b", "user-b");

        latestSocket().open();
        await settleIndexedDb();

        // Replaying would attribute user-a's write to user-b — terminal, and
        // purged so a later hydrate can't resurrect it.
        expect(fetchMock).not.toHaveBeenCalled();
        expect(settled).toEqual(["rejected"]);
        await expect(createAsyncStoragePersistence({ storage }).load()).resolves.toEqual([]);

        client.close();
    });

    it("5c. opens a socket for a hydrated write's shard after a crossTabSync tab self-promotes, with no subscription on it", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const storage = createFakeAsyncStorage();
        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } }));

        await createAsyncStoragePersistence({ storage }).append({
            args: { title: "write-only" },
            functionPath: "posts:create",
            id: "m1",
            identity: "subj:user-a",
            shardKey: "s1",
        });

        // No `subscribe()` anywhere: this shard is write-only, which is exactly
        // the case `onBecomeLeader`'s subscription replay does not cover.
        const client = new LunoraClient({
            crossTabSync: true,
            fetch: fetchMock,
            persistence: createAsyncStoragePersistence({ storage }),
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.setAuthToken("token-a", "user-a");

        // Hydration runs inside the coordinator's startup claim window, where
        // `ensureSocket` is a no-op because this tab is not (yet) the leader.
        await vi.advanceTimersByTimeAsync(0);

        expect(sockets).toHaveLength(0);

        // Self-promotion after a full `leaderTimeout` with no other tab answering.
        await vi.advanceTimersByTimeAsync(3000);

        expect(sockets.map((socket) => new URL(socket.url).searchParams.get("shard"))).toEqual(["s1"]);

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

    it("14. splits a batch chunk the worker refuses with 413 instead of rejecting every write in it", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const attempted: number[] = [];
        const accepted: number[] = [];

        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            if (!(input as string).endsWith("/_lunora/rpc-batch")) {
                throw new Error(`unexpected single-call fetch to ${input as string}`);
            }

            const { calls } = JSON.parse((init as RequestInit).body as string) as { calls: { id: number }[] };

            attempted.push(calls.length);

            // Stands in for the worker's 1 MiB body cap, shrunk to two entries.
            // The refusal covers the WHOLE chunk, exactly as `PAYLOAD_TOO_LARGE`
            // does — treating it as a verdict would drop every write in it.
            if (calls.length > 2) {
                return jsonResponse({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large" } }, { status: 413 });
            }

            accepted.push(calls.length);

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

        const pending = Promise.all(Array.from({ length: 5 }, (_, index) => client.mutation(fnRef("posts:create"), { index })));

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const results = await pending;

        // The over-cap chunk was attempted whole...
        expect(attempted[0]).toBe(5);
        // ...refused, then halved until it fit — never over the server's cap...
        expect(Math.max(...accepted)).toBeLessThanOrEqual(2);
        // ...with every write sent exactly once in an accepted chunk...
        expect(accepted.reduce((sum, size) => sum + size, 0)).toBe(5);
        // ...so all five committed instead of settling `rejected` wholesale.
        expect(results).toHaveLength(5);

        client.close();
    });

    it("15. splits a batch chunk over the body budget before sending it", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const bodyBytes: number[] = [];

        const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
            if (!(input as string).endsWith("/_lunora/rpc-batch")) {
                throw new Error(`unexpected single-call fetch to ${input as string}`);
            }

            const body = (init as RequestInit).body as string;
            const bytes = new TextEncoder().encode(body).length;

            bodyBytes.push(bytes);

            const { calls } = JSON.parse(body) as { calls: { id: number }[] };

            // The worker's real cap: a body over 1 MiB never reaches a handler.
            if (bytes > 1_048_576) {
                return jsonResponse({ error: { code: "PAYLOAD_TOO_LARGE", message: "request body too large" } }, { status: 413 });
            }

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

        // Three writes well under the 500-entry cap but ~1.2 MiB together:
        // count-only chunking sends them as one body the worker refuses.
        const blob = "x".repeat(400_000);
        const pending = Promise.all(Array.from({ length: 3 }, (_, index) => client.mutation(fnRef("posts:create"), { blob, index })));

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.runAllTimersAsync();

        const results = await pending;

        // Split BEFORE sending — no request ever went out over the cap...
        expect(Math.max(...bodyBytes)).toBeLessThanOrEqual(1_048_576);
        expect(bodyBytes.length).toBeGreaterThan(1);
        // ...and every write committed.
        expect(results).toHaveLength(3);

        client.close();
    });

    it("16. re-queues a lone write when a gateway answers with no error envelope", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        let attempt = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            attempt += 1;

            // An edge/proxy blip: a 502 HTML page, no `{ error }` envelope. The
            // server reached no verdict, so the durable write must survive it —
            // as it already does when two or more writes are queued (the batch path).
            if (attempt === 1) {
                return new Response("<html><body>502 Bad Gateway</body></html>", { headers: { "content-type": "text/html" }, status: 502 });
            }

            return jsonResponse({ result: { id: "recovered" } });
        });

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const settled: { status: string }[] = [];

        client.onMutationSettled((event) => settled.push(event));

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // Exactly ONE queued write — the depth at which the single-call replay
        // path is taken.
        let outcome: string | undefined;
        const pending = client.mutation(fnRef("posts:create"), { title: "lone" }).then(
            (value) => {
                outcome = "committed";

                return value;
            },
            (error: unknown) => {
                outcome = "rejected";

                return error;
            },
        );

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        // Nothing settled: the write is still queued, waiting for the next flush.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(settled).toEqual([]);
        expect(outcome).toBeUndefined();

        // Next reconnect → the same write replays and commits.
        latestSocket().triggerClose();
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);
        await pending;

        expect(outcome).toBe("committed");
        expect(settled.map((event) => event.status)).toEqual(["committed"]);

        client.close();
    });

    it("17. waits out a 429's retry hint instead of dropping the queued write", async () => {
        expect.assertions(6);

        vi.useFakeTimers();

        let attempt = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            attempt += 1;

            // Round 1 — the runtime's REST limiter: a `RATE_LIMITED` envelope
            // whose hint rides in the `Retry-After` header (whole seconds).
            if (attempt === 1) {
                return jsonResponse(
                    { error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } },
                    { headers: { "content-type": "application/json", "retry-after": "3" }, status: 429 },
                );
            }

            // Round 2 — the protocol fixture's shape: `TOO_MANY_REQUESTS` with
            // `data.retryAfterMs`.
            if (attempt === 2) {
                return jsonResponse({ error: { code: "TOO_MANY_REQUESTS", data: { retryAfterMs: 1000 }, message: "slow down" } }, { status: 429 });
            }

            return jsonResponse({ result: { id: "accepted" } });
        });

        const client = new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const settled: { status: string }[] = [];

        client.onMutationSettled((event) => settled.push(event));

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fnRef("posts:create"), { title: "limited" }).catch(() => "rejected");

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        // A rate limiter reached no verdict on the write — nothing settled.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(settled).toEqual([]);

        // The hint is honoured, not ignored: no retry a millisecond early.
        await vi.advanceTimersByTimeAsync(2999);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Round 2's `data.retryAfterMs` schedules the next attempt just the same.
        await vi.advanceTimersByTimeAsync(1000);

        expect(fetchMock).toHaveBeenCalledTimes(3);

        await expect(pending).resolves.toEqual({ id: "accepted" });

        client.close();
    });
});

/**
 * The outbox's retry policy under failures the server left no readable verdict
 * on: a refusal with no `Retry-After` hint, a hint per shard key, the HTTP-date
 * form of `Retry-After`, and a non-2xx that is not a Lunora error envelope at
 * all. Same harness as the lifecycle suite above — a real client, a mock socket,
 * and a `fetch` that answers the way a limiter or an edge proxy does.
 */
describe("outbox replay backoff", () => {
    beforeEach(() => {
        sockets.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    const offlineClient = (fetchMock: typeof fetch): LunoraClient =>
        new LunoraClient({
            fetch: fetchMock,
            heartbeatIntervalMs: 0,
            reconnect: { initialDelayMs: 10, jitter: false, maxDelayMs: 10 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

    it("backs off a rate-limit refusal that carried no hint at all", async () => {
        expect.assertions(4);

        vi.useFakeTimers();
        // Pin the jitter so the backoff is one number a test can wait on:
        // 1000ms base * (0.5 + 0.5 * 0.5) = 750ms.
        vi.spyOn(Math, "random").mockReturnValue(0.5);

        let attempt = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            attempt += 1;

            // A limiter that refused the write and said nothing about when to
            // come back — no `Retry-After` header, no `data.retryAfterMs`.
            if (attempt === 1) {
                return jsonResponse({ error: { code: "TOO_MANY_REQUESTS", message: "slow down" } }, { status: 429 });
            }

            return jsonResponse({ result: { id: "accepted" } });
        });

        const client = offlineClient(fetchMock);

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fnRef("posts:create"), { title: "hintless" });

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The socket stays open through a 429, so nothing else will ever
        // schedule this flush — without a default backoff the write is stranded.
        await vi.advanceTimersByTimeAsync(749);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(pending).resolves.toEqual({ id: "accepted" });

        client.close();
    });

    it("keys the retry hint per shard, so one limited shard cannot strand another", async () => {
        expect.assertions(5);

        vi.useFakeTimers();

        const attempts: unknown[] = [];
        const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
            const { shardKey } = JSON.parse((init?.body ?? "{}") as string) as { shardKey?: string };

            attempts.push(shardKey);

            // First refusal per shard, with two very different hints: the long
            // one must not become the short one's wait, and neither flush may
            // consume the other's.
            if (attempts.filter((key) => key === shardKey).length === 1) {
                return jsonResponse(
                    { error: { code: "TOO_MANY_REQUESTS", data: { retryAfterMs: shardKey === "room-a" ? 30_000 : 500 }, message: "slow down" } },
                    { status: 429 },
                );
            }

            return jsonResponse({ result: { id: `${String(shardKey)}-accepted` } });
        });

        const client = offlineClient(fetchMock);

        client.subscribe(fnRef("posts:list"), {}, () => undefined, { shardKey: "room-a" });
        client.subscribe(fnRef("posts:list"), {}, () => undefined, { shardKey: "room-b" });

        sockets[0]?.open();
        sockets[1]?.open();
        sockets[0]?.triggerClose();
        sockets[1]?.triggerClose();

        const pendingA = client.mutation(fnRef("posts:create"), { title: "a" }, { shardKey: "room-a" });
        const pendingB = client.mutation(fnRef("posts:create"), { title: "b" }, { shardKey: "room-b" });

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        sockets[2]?.open();
        sockets[3]?.open();
        await vi.advanceTimersByTimeAsync(0);

        expect(attempts.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual(["room-a", "room-b"]);

        // `room-b` waits out its own 500ms hint, not `room-a`'s 30s one.
        await vi.advanceTimersByTimeAsync(500);

        expect(attempts.filter((key) => key === "room-b")).toHaveLength(2);
        await expect(pendingB).resolves.toEqual({ id: "room-b-accepted" });

        // ...and `room-a` still retries on its own, rather than having had its
        // hint consumed by the shard that flushed alongside it.
        await vi.advanceTimersByTimeAsync(29_500);

        expect(attempts.filter((key) => key === "room-a")).toHaveLength(2);
        await expect(pendingA).resolves.toEqual({ id: "room-a-accepted" });

        client.close();
    });

    it("waits out a `Retry-After` sent as an HTTP-date", async () => {
        expect.assertions(4);

        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        vi.spyOn(Math, "random").mockReturnValue(0.5);

        let attempt = 0;
        const fetchMock = vi.fn<typeof fetch>(async () => {
            attempt += 1;

            // RFC 9110 allows delta-seconds OR an HTTP-date, and a proxy in
            // front of the worker sends the form the client never parsed.
            if (attempt === 1) {
                return jsonResponse(
                    { error: { code: "TOO_MANY_REQUESTS", message: "slow down" } },
                    { headers: { "retry-after": "Thu, 01 Jan 2026 00:00:02 GMT" }, status: 429 },
                );
            }

            return jsonResponse({ result: { id: "accepted" } });
        });

        const client = offlineClient(fetchMock);

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fnRef("posts:create"), { title: "dated" });

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        // The date is 2s out — honoured as 2s, neither read as `NaN` nor left to
        // the 750ms hintless backoff.
        await vi.advanceTimersByTimeAsync(1979);

        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(20);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        await expect(pending).resolves.toEqual({ id: "accepted" });

        client.close();
    });

    it("settles a lone write on an envelope-less 4xx instead of replaying it forever", async () => {
        expect.assertions(4);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(
            async () => new Response("<html><body>403 Forbidden</body></html>", { headers: { "content-type": "text/html" }, status: 403 }),
        );
        const client = offlineClient(fetchMock);
        const settled: { status: string }[] = [];

        client.onMutationSettled((event) => settled.push(event));

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        const pending = client.mutation(fnRef("posts:create"), { title: "refused" }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        // A proxy that refused the REQUEST outright: no `{ error }` envelope to
        // classify, but a status that says replaying can only reproduce it. The
        // write settles, and the queue moves.
        await expect(pending).resolves.toMatchObject({ code: "FORBIDDEN" });
        expect(settled.map((event) => event.status)).toEqual(["rejected"]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("settles a whole batch on an envelope-less 4xx instead of wedging the outbox head", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(
            async () => new Response("<html><body>400 Bad Request</body></html>", { headers: { "content-type": "text/html" }, status: 400 }),
        );
        const client = offlineClient(fetchMock);

        client.subscribe(fnRef("posts:list"), {}, () => undefined);
        latestSocket().open();
        latestSocket().triggerClose();

        // Two writes take the batch path, where the same unreadable reply used
        // to re-queue the whole chunk unconditionally.
        const first = client.mutation(fnRef("posts:create"), { title: "one" }).catch((error: unknown) => error);
        const second = client.mutation(fnRef("posts:create"), { title: "two" }).catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10);
        latestSocket().open();
        await vi.advanceTimersByTimeAsync(0);

        await expect(first).resolves.toMatchObject({ code: "BAD_REQUEST" });
        await expect(second).resolves.toMatchObject({ code: "BAD_REQUEST" });
        expect(client.pendingCount()).toBe(0);

        client.close();
    });
});
