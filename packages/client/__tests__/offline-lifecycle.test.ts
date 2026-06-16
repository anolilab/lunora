import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
});
