import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference, PersistenceAdapter } from "../src/types";

/**
 * `mutation(…, { onlineOnly: true })`: a write that is never queued, persisted or
 * replayed. While its connection is not live it is refused at once with
 * `OFFLINE_NOT_QUEUED`, and its args never reach the persistence adapter. A normal
 * write in the same state still queues — the guard against an over-broad gate.
 */

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

/**
 * Spies the adapter's `append` and returns a promise that settles once `count` writes are
 * in it. A queued write is in the queue from that moment, so it is the milestone to await.
 */
const spyAppend = (persistence: PersistenceAdapter, count: number) => {
    const original = persistence.append;
    let persistedCount = 0;
    let markPersisted: () => void = () => {};
    const persisted = new Promise<void>((resolve) => {
        markPersisted = resolve;
    });
    const append = vi.spyOn(persistence, "append").mockImplementation(async (mutation) => {
        await original(mutation);

        persistedCount += 1;

        if (persistedCount === count) {
            markPersisted();
        }
    });

    return { append, persisted };
};

interface MockSocket {
    open: () => void;
    triggerClose: () => void;
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        public readonly sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                triggerClose: () => {
                    this.readyState = 3;
                    this.emit("close");
                },
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public close(): void {
            this.readyState = 3;
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            // Writes under test ride HTTP; recorded only so a stray frame is visible.
            this.sent.push(raw);
        }

        private emit(type: string): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener();
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** Every write marker the server saw, in the order the requests reached it. */
const MARKERS = /OLDER|NEWER|LIVE/g;

const createServer = (): { fetch: typeof fetch; observed: string[] } => {
    const observed: string[] = [];

    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
        // The session probe the hold path re-issues — keep it failing so the
        // subject stays unconfirmed and the queued write stays held.
        if (url.includes("get-session")) {
            return Response.json({ error: "nope" }, { status: 401 });
        }

        const raw = typeof init?.body === "string" ? init.body : "{}";

        for (const match of raw.matchAll(MARKERS)) {
            observed.push(match[0]);
        }

        return Response.json({ result: { ok: true } }, { status: 200 });
    });

    return { fetch: fetchImpl as unknown as typeof fetch, observed };
};

const outcomeOf = (promise: Promise<unknown>): Promise<string> =>
    promise.then(
        () => "committed",
        (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
    );

/** A transport that never reaches the origin: every request fails the way a fetch does when offline. */
const unreachable = (): typeof fetch => async () => {
    throw new TypeError("fetch failed");
};

describe("online-only mutation", () => {
    it("refuses with OFFLINE_NOT_QUEUED when a never-connected client's request fails on the wire", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = new LunoraClient({
            fetch: unreachable(),
            heartbeatIntervalMs: 0,
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        await expect(client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true })).rejects.toMatchObject({
            cause: expect.any(TypeError),
            code: "OFFLINE_NOT_QUEUED",
        });

        expect(append).not.toHaveBeenCalled();
        await expect(persistence.load()).resolves.toStrictEqual([]);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("leaves a normal write's transport error unchanged before the first connect", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = new LunoraClient({
            fetch: unreachable(),
            heartbeatIntervalMs: 0,
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        await expect(client.mutation(fnRef("todos.set"), { text: "NEWER" })).rejects.toBeInstanceOf(TypeError);

        expect(append).not.toHaveBeenCalled();
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("keeps the transport error of an online-only write on a live connection", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({
            fetch: unreachable(),
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();

        const failed = client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true });

        await expect(failed).rejects.toBeInstanceOf(TypeError);

        client.close();
    });

    it("does not reclassify a server error as OFFLINE_NOT_QUEUED", async () => {
        expect.hasAssertions();

        const client = new LunoraClient({
            fetch: async () => Response.json({ error: { code: "INVALID_ARGUMENT", message: "bad" } }, { status: 400 }),
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket: createMockWebSocket([]),
        });

        await expect(client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true })).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
        });

        client.close();
    });

    it("sends normally while the connection is live", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();

        await expect(client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true })).resolves.toStrictEqual({ ok: true });

        expect(server.observed).toStrictEqual(["LIVE"]);
        expect(append).not.toHaveBeenCalled();
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("refuses at once while disconnected, and never hands its args to the queue or the adapter", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        sockets.at(-1)?.triggerClose();

        const refused = client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true });

        await expect(refused).rejects.toMatchObject({ code: "OFFLINE_NOT_QUEUED" });

        expect(server.observed).toStrictEqual([]);
        expect(append).not.toHaveBeenCalled();
        await expect(persistence.load()).resolves.toStrictEqual([]);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("is not queued behind a backlog: it goes out while an older write is held", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const { append, persisted } = spyAppend(persistence, 1);
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        // A write queued under `user-1`, then held: the JWT is refreshed without a
        // subject, so the replay verdict is "hold" and the backlog stays queued
        // while the socket is open. That is the state the FIFO gate reads.
        client.setAuthToken("jwt-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const older = outcomeOf(client.mutation(fnRef("todos.set"), { text: "OLDER" }));

        client.setAuthToken("jwt-2");
        sockets.at(-1)?.open();
        await persisted;

        const live = client.mutation(fnRef("todos.set"), { text: "LIVE" }, { onlineOnly: true });

        // The write's own commit is the milestone: it went out while the backlog stayed queued.
        await expect(live).resolves.toStrictEqual({ ok: true });

        expect(server.observed).toStrictEqual(["LIVE"]);
        expect(client.pendingCount()).toBe(1);
        expect(append).toHaveBeenCalledTimes(1);

        // The backlog is untouched: the older write stays queued until its subject is back,
        // then commits.
        client.setAuthToken("jwt-2", "user-1");

        await expect(older).resolves.toBe("committed");
        expect(server.observed).toStrictEqual(["LIVE", "OLDER"]);

        client.close();
    });

    it("still queues a normal write while disconnected", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const { append, persisted } = spyAppend(persistence, 1);
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        sockets.at(-1)?.triggerClose();

        const queued = outcomeOf(client.mutation(fnRef("todos.set"), { text: "NEWER" }));

        await persisted;

        expect(client.pendingCount()).toBe(1);
        expect(append).toHaveBeenCalledTimes(1);
        expect(server.observed).toStrictEqual([]);

        client.close();

        await expect(queued).resolves.toMatch(/^rejected:/u);
    });

    it("still queues a normal write behind a backlog", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const { append, persisted } = spyAppend(persistence, 2);
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.setAuthToken("jwt-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const older = outcomeOf(client.mutation(fnRef("todos.set"), { text: "OLDER" }));

        client.setAuthToken("jwt-2");
        sockets.at(-1)?.open();

        const newer = outcomeOf(client.mutation(fnRef("todos.set"), { text: "NEWER" }));

        await persisted;

        expect(client.pendingCount()).toBe(2);
        expect(append).toHaveBeenCalledTimes(2);
        expect(server.observed).toStrictEqual([]);

        client.close();

        await expect(older).resolves.toMatch(/^rejected:/u);
        await expect(newer).resolves.toMatch(/^rejected:/u);
    });
});
