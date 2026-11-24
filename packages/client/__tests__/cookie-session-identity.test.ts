import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getIdentityStore } from "../src/auth";
import { QUERY_CACHE_DEBOUNCE_MS } from "../src/client-tuning";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createInMemoryQueryCache } from "../src/query-cache";
import type { FunctionReference, PersistenceAdapter, QueryCacheAdapter } from "../src/types";

/**
 * Cookie sessions, and the three identity gates that were disarmed by never
 * resolving one.
 *
 * A cookie session is better-auth's default, what `@lunora/auth-ui` is built on
 * and what `examples/auth-playground` ships: `new LunoraClient({ url })` and no
 * `setAuthToken` ever. The identity store used to declare such a client signed
 * out without asking the server, so `identityFingerprint()` stayed `null` for
 * every user of every such app — and every gate that compares a stamp against it
 * compared `null` with `null` and said "same identity".
 *
 * Each test below is one of those gates, driven end to end.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Spy on the session probe the identity store runs, so a test can wait for its answer. */
const watchSessionProbe = (client: LunoraClient): MockInstance<LunoraClient["getCurrentUser"]> => vi.spyOn(client, "getCurrentUser");

/**
 * The session answer the identity store asked for last, once the client has adopted it. The store
 * asks synchronously from its first subscriber, and the client adopts the subject before that call
 * resolves.
 */
const sessionAnswered = async (probe: MockInstance<LunoraClient["getCurrentUser"]>): Promise<void> => {
    const latest = probe.mock.results.at(-1);

    if (latest === undefined) {
        throw new Error("the identity store never asked for the session");
    }

    await latest.value;
};

/** Resolves once the client's offline queue holds `count` writes — a restored or a newly queued one. */
const pendingIs = async (client: LunoraClient, count: number): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const unsubscribe = client.onPendingChange((pending) => {
        if (pending === count) {
            resolve(undefined);
        }
    });

    await promise;
    unsubscribe();
};

/** Resolves once the durable outbox drops a record: the write was replayed, or purged unsent. */
const nextRemoval = (persistence: PersistenceAdapter): Promise<void> => {
    const { promise, resolve } = Promise.withResolvers<undefined>();
    const { remove } = persistence;

    vi.spyOn(persistence, "remove").mockImplementation(async (id) => {
        await remove(id);
        resolve(undefined);
    });

    return promise;
};

/** Run the read cache's write debounce and wait for whatever it writes to land. */
const flushReadCache = async (put: MockInstance<QueryCacheAdapter["put"]>): Promise<void> => {
    await vi.advanceTimersByTimeAsync(QUERY_CACHE_DEBOUNCE_MS);
    await Promise.all(put.mock.results.map(async (result) => result.value));
};

interface MockSocket {
    closed: boolean;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: Record<string, unknown>[];
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        private readonly sent: Record<string, unknown>[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        private readonly record: MockSocket;

        public constructor(url: string) {
            this.url = url;
            this.record = {
                closed: false,
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload: unknown) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
            };
            sockets.push(this.record);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public close(): void {
            this.readyState = 3;
            this.record.closed = true;
            this.emit("close", { code: 1000 });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as Record<string, unknown>);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** `/get-session` answering with a cookie-authenticated user, everything else OK. */
const cookieSessionFetch = (user: { email: string; id: string } | null): ReturnType<typeof vi.fn<typeof fetch>> =>
    vi.fn<typeof fetch>(async (input: unknown) => {
        if (String(input).includes("get-session")) {
            return Response.json(user === null ? {} : { user }, { headers: { "content-type": "application/json" }, status: 200 });
        }

        return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
    });

const isProbe = (call: unknown[]): boolean => String(call[0]).includes("get-session");

describe("c4 — a cookie session resolves an identity", () => {
    it("probes once when no token is held and labels the identity with the resolved subject", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const fetchImpl = cookieSessionFetch({ email: "a@b.co", id: "user-a" });
        // The shape `examples/auth-playground` ships: a url, and nothing else.
        const client = new LunoraClient({ fetch: fetchImpl, heartbeatIntervalMs: 0, url: "http://app.test", WebSocket: createMockWebSocket() });
        const probe = watchSessionProbe(client);
        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        await sessionAnswered(probe);

        expect(store.getStatus()).toBe("authenticated");
        expect(store.getUser()).toStrictEqual({ email: "a@b.co", id: "user-a" });
        // `adoptResolvedSubject` is the only thing that labels a cookie identity.
        expect(client.currentIdentity()).toBe("subj:user-a");

        // One probe, not one per subscriber.
        const probes = fetchImpl.mock.calls.filter((call) => isProbe(call)).length;

        // A probe goes out synchronously from `subscribe` when it goes out at all.
        store.subscribe(() => undefined);

        expect(fetchImpl.mock.calls.filter((call) => isProbe(call))).toHaveLength(probes);

        client.close();
    });

    it("does not flash unauthenticated before the probe answers", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch({ email: "a@b.co", id: "user-a" }),
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const probe = watchSessionProbe(client);
        const store = getIdentityStore(client);
        const seen: string[] = [];

        store.subscribe(() => seen.push(store.getStatus()));

        expect(store.getStatus()).toBe("loading");

        await sessionAnswered(probe);

        expect(seen.at(-1)).toBe("authenticated");
        expect(seen).not.toContain("unauthenticated");

        client.close();
    });

    it("still reports unauthenticated once the server answers that there is no session", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch(null),
            heartbeatIntervalMs: 0,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const probe = watchSessionProbe(client);
        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        await sessionAnswered(probe);

        expect(store.getStatus()).toBe("unauthenticated");
        expect(client.currentIdentity()).toBeNull();

        client.close();
    });
});

describe("c1 — an offline write queued under no identity", () => {
    it("is never replayed as the user who happens to be signed in next", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const persistence = createInMemoryPersistence();

        // What user A's tab left behind: a durable write stamped with the `null`
        // identity, because nothing ever resolved A's cookie session.
        await persistence.append({
            args: { text: "written by A" },
            functionPath: "todos.add",
            id: "m_a_1",
            identity: null,
        });

        // A signs out, B signs in, the page reloads.
        const purged = nextRemoval(persistence);
        const fetchImpl = cookieSessionFetch({ email: "b@b.co", id: "user-b" });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        const probe = watchSessionProbe(client);

        getIdentityStore(client).subscribe(() => undefined);
        client.subscribe(fnRef("todos.list"), {}, () => {});
        // The reload's starting point: B's session named, A's write restored from disk.
        await Promise.all([sessionAnswered(probe), pendingIs(client, 1)]);

        sockets.at(-1)?.open();
        // The replay gate's verdict on the record, whichever it is, ends in its removal.
        await purged;

        const replays = fetchImpl.mock.calls.filter((call) => JSON.stringify(call[1] ?? "").includes("todos.add"));

        expect(replays).toStrictEqual([]);
        // Terminal, not stranded: B's session proved the stamp belongs to nobody
        // this client can speak for, so the record is purged rather than retried.
        await expect(persistence.load()).resolves.toStrictEqual([]);

        client.close();
    });

    it("is HELD while the session resolve is still in flight, then flushed once it settles", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const persistence = createInMemoryPersistence();

        await persistence.append({
            args: { text: "queued before the session resolved" },
            functionPath: "todos.add",
            id: "m_own_1",
            identity: null,
        });

        // `/get-session` hangs, so the socket's `open` flush wins the race the
        // leak lived in. The write must wait for the answer rather than go out
        // on whatever ambient cookie the browser happens to be carrying.
        let answerProbe = (): void => {};
        const probed = new Promise<void>((resolve) => {
            answerProbe = resolve;
        });
        const replayed = nextRemoval(persistence);
        const fetchImpl = vi.fn<typeof fetch>(async (input: unknown) => {
            if (String(input).includes("get-session")) {
                await probed;

                return Response.json({}, { headers: { "content-type": "application/json" }, status: 200 });
            }

            return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        getIdentityStore(client).subscribe(() => undefined);
        client.subscribe(fnRef("todos.list"), {}, () => {});
        await pendingIs(client, 1);

        sockets.at(-1)?.open();
        // One I/O turn: an unheld open flush has sent the write by now.
        await new Promise((resolve) => {
            setImmediate(resolve);
        });

        const replays = (): unknown[] => fetchImpl.mock.calls.filter((call) => JSON.stringify(call[1] ?? "").includes("todos.add"));

        // Held: still queued, still persisted, nothing sent.
        expect(replays()).toStrictEqual([]);
        await expect(persistence.load()).resolves.toHaveLength(1);

        // The server answers "no session". `null` is a settled identity now, the
        // write is this client's own, and the hold ends without a reconnect.
        answerProbe();
        await replayed;

        expect(replays()).toHaveLength(1);
        await expect(persistence.load()).resolves.toStrictEqual([]);

        client.close();
    });
});

describe("c2 — the durable read cache under no identity", () => {
    // The read cache writes on a debounce timer; these move past it rather than waiting it out.
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /**
     * Write one real cache entry through a signed-in client (so the key is the
     * client's own, not a guess), then re-stamp it `identity: null` — the shape
     * a cookie app wrote for every one of its users.
     */
    const seedCache = async (queryCache: QueryCacheAdapter): Promise<void> => {
        sockets.length = 0;

        const put = vi.spyOn(queryCache, "put");
        const writer = new LunoraClient({
            fetch: cookieSessionFetch({ email: "a@b.co", id: "user-a" }),
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            persistence: false,
            queryCache,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        await writer.whenReady();
        writer.setAuthToken("tok-a", "user-a");
        writer.subscribe(fnRef("todos.list"), {}, () => {});

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 5, data: [{ _id: "t1", text: "A's private message" }], id: subscribeId, type: "data" });
        await flushReadCache(put);
        writer.close();

        const stored = await queryCache.load();
        const entry = stored.at(0);

        if (entry === undefined) {
            throw new Error("the writer session cached nothing — the rest of this test would pass vacuously");
        }

        // Control: the cache really is writable in this harness.
        expect(entry.identity).toBe("subj:user-a");

        await queryCache.put(entry.key, { ...entry, credential: undefined, identity: null });
    };

    it("never seeds a subscription from an entry stamped with no identity", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await seedCache(queryCache);

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch({ email: "b@b.co", id: "user-b" }),
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            persistence: false,
            queryCache,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const probe = watchSessionProbe(client);

        await client.whenReady();
        // What every adapter's auth gate does on mount, and what puts the
        // identity into "resolving" while the first queries subscribe.
        getIdentityStore(client).subscribe(() => undefined);

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();

        // B's session is named here, and the hydrated cache reseeds against it.
        await sessionAnswered(probe);

        expect(seeded).toBeUndefined();

        client.close();
    });

    it("never persists a value while the identity is still resolving", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const queryCache = createInMemoryQueryCache();
        const put = vi.spyOn(queryCache, "put");
        // `/get-session` hangs, so the frame lands while the identity is still
        // one round trip from `subj:<id>`.
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async (input: unknown) => {
                if (String(input).includes("get-session")) {
                    await new Promise(() => {});
                }

                return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
            }),
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            persistence: false,
            queryCache,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        await client.whenReady();
        getIdentityStore(client).subscribe(() => undefined);
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 3, data: [{ _id: "t1", text: "A's private message" }], id: subscribeId, type: "data" });
        await flushReadCache(put);

        await expect(queryCache.load()).resolves.toStrictEqual([]);

        client.close();
    });

    it("still persists for a client with no identity to resolve", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        // The control that keeps the gate above from being "never persist": an
        // app with no auth at all has a `null` fingerprint nobody else shares,
        // and its offline read cache must keep working.
        const queryCache = createInMemoryQueryCache();
        const put = vi.spyOn(queryCache, "put");
        const client = new LunoraClient({
            fetch: async () => Response.json({}),
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            persistence: false,
            queryCache,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        await client.whenReady();
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 3, data: [{ _id: "t1", text: "a public row" }], id: subscribeId, type: "data" });
        await flushReadCache(put);

        await expect(queryCache.load()).resolves.toHaveLength(1);

        client.close();
    });
});

describe("c3 — an account switch", () => {
    it("does not relabel the outgoing user's queued write when a cookie session changes hands", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        let sessionUser = { email: "a@b.co", id: "user-a" };
        const fetchImpl = vi.fn<typeof fetch>(async (input: unknown) => {
            if (String(input).includes("get-session")) {
                return Response.json({ user: sessionUser }, { headers: { "content-type": "application/json" }, status: 200 });
            }

            return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        await client.getCurrentUser();

        expect(client.currentIdentity()).toBe("subj:user-a");

        const settled: (string | undefined)[] = [];

        client.onMutationSettled((event) => settled.push((event.error as { code?: string } | undefined)?.code));

        client.subscribe(fnRef("todos.list"), {}, () => {});

        const pending = client.mutation(fnRef("todos.add"), { text: "written by A" });
        // Never let the rejection float.
        const outcome = pending.then(
            () => "committed",
            () => "rejected",
        );

        await pendingIs(client, 1);

        // A signs out and B signs in — same origin, same cookie jar, no token on
        // either side of the switch. `!tokenChanged` is true here and says
        // nothing whatever about who this is.
        sessionUser = { email: "b@b.co", id: "user-b" };
        await client.getCurrentUser();

        expect(client.currentIdentity()).toBe("subj:user-b");
        await expect(outcome).resolves.toBe("rejected");
        expect(settled).toStrictEqual(["OFFLINE_IDENTITY_CHANGED"]);

        const replays = fetchImpl.mock.calls.filter((call) => JSON.stringify(call[1] ?? "").includes("todos.add"));

        expect(replays).toStrictEqual([]);

        client.close();
    });

    it("closes the previous user's socket and takes their rows off screen", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch({ email: "a@b.co", id: "user-a" }),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        client.setAuthToken("tok-a", "user-a");

        const seen: unknown[] = [];

        client.subscribe(fnRef("todos.list"), {}, (value) => seen.push(value));

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 4, data: [{ _id: "t1", text: "A's private row" }], id: subscribeId, type: "data" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "t1", text: "A's private row" }]);

        // B signs in on the same client.
        client.setAuthToken("tok-b", "user-b");

        expect(socket?.closed).toBe(true);
        // The value on screen belonged to A; B must not keep looking at it.
        expect(seen.at(-1)).toBeUndefined();

        let replayed: unknown = "not-called";

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            replayed = value;
        });

        expect(replayed).toBe("not-called");

        client.close();
    });
});
