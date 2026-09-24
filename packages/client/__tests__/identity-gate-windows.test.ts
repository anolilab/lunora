import { describe, expect, it, vi } from "vitest";

import { getIdentityStore } from "../src/auth";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryQueryCache } from "../src/query-cache";
import type { FunctionReference, QueryCacheAdapter } from "../src/types";

/**
 * The windows the cookie-session fix left open.
 *
 * Resolving a cookie session gave `identityFingerprint()` a real value and armed
 * the gates — but only for the span of a `/get-session` request. Before the
 * first one starts, and after one fails to produce an answer, the fingerprint is
 * `null` again with nothing marking it provisional, and `null === null` matches
 * the previous cookie user's cached rows and queued writes exactly as before.
 * The socket half has the same shape: a retired connection's already-queued
 * frame lands after the eviction that was supposed to end it.
 *
 * The control these must not break is an app with **no auth at all**: its `null`
 * fingerprint is settled forever and nobody else shares it, so its read cache
 * and its offline queue have to keep working.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Long enough to clear the read cache's 250ms write debounce. */
const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 60);
        });
    }
};

interface MockSocket {
    closed: boolean;
    /** Fire the `close` event a deferred `close()` withheld. */
    flushClose: () => void;
    open: () => void;
    receive: (payload: unknown) => void;
    sent: Record<string, unknown>[];
}

const sockets: MockSocket[] = [];

/**
 * @param deferClose when true, `close()` marks the socket closed but withholds
 * the `close` event — what a real browser does, and the window in which a
 * frame already queued on a retired socket still arrives with
 * `conn.socket === socket`.
 */
const createMockWebSocket = (deferClose = false): typeof WebSocket => {
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
                flushClose: () => {
                    this.emit("close", { code: 1000 });
                },
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

            if (!deferClose) {
                this.emit("close", { code: 1000 });
            }
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

/**
 * Write one real cache entry through a signed-in client, then re-stamp it
 * `identity: null` — the shape a cookie app wrote for every one of its users.
 */
const seedNullStampedCache = async (queryCache: QueryCacheAdapter): Promise<void> => {
    sockets.length = 0;

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
    await settle();
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

describe("f1 — a first probe that never answered", () => {
    it("is retried rather than answered from the absent token", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        let failNext = true;
        const fetchImpl = vi.fn<typeof fetch>(async (input: unknown) => {
            if (String(input).includes("get-session")) {
                if (failNext) {
                    failNext = false;

                    throw new TypeError("network down");
                }

                return Response.json({ user: { email: "a@b.co", id: "user-a" } }, { headers: { "content-type": "application/json" }, status: 200 });
            }

            return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
        });
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const store = getIdentityStore(client);

        store.subscribe(() => undefined);
        await settle();

        // The endpoint could not be reached — nothing was learned about the
        // session, so the credential (a cookie this code cannot see) stands.
        expect(store.getStatus()).toBe("unreachable");

        // The connection comes back, which is the store's one recovery hook.
        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        await settle();

        // A failed round trip is not an answer: the recovery must ASK again, not
        // read the absent bearer token as a sign-out.
        expect(fetchImpl.mock.calls.filter((call) => isProbe(call))).toHaveLength(2);
        expect(store.getStatus()).toBe("authenticated");
        expect(client.currentIdentity()).toBe("subj:user-a");

        client.close();
    });
});

describe("f2 — two concurrent session probes", () => {
    it("never lets the older answer replace the subject the newer established", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const gates: (() => void)[] = [];
        const users = [
            { email: "a@b.co", id: "user-a" },
            { email: "b@b.co", id: "user-b" },
        ];
        let probeIndex = 0;

        const fetchImpl = vi.fn<typeof fetch>(async (input: unknown) => {
            if (String(input).includes("get-session")) {
                const user = users[probeIndex] ?? users[1];

                probeIndex += 1;

                await new Promise<void>((resolve) => {
                    gates.push(resolve);
                });

                return Response.json({ user }, { headers: { "content-type": "application/json" }, status: 200 });
            }

            return Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });
        });
        // A cookie app: no token on either probe, so `requestToken` is `null`
        // for both and the token check in `adoptResolvedSubject` passes for both.
        const client = new LunoraClient({
            fetch: fetchImpl,
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        const older = client.getCurrentUser();
        const newer = client.getCurrentUser();

        await settle();

        expect(gates).toHaveLength(2);

        // The NEWER probe answers first and names user-b.
        gates[1]?.();
        await newer;
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-b");

        // The older answer arrives late. It is about a question this client has
        // already superseded — adopting it hands the session back to user-a.
        gates[0]?.();
        await older;
        await settle();

        expect(client.currentIdentity()).toBe("subj:user-b");

        client.close();
    });
});

describe("f3 — the fingerprint is provisional outside the probe too", () => {
    it("refuses a null-stamped cache entry BEFORE the first probe starts", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await seedNullStampedCache(queryCache);

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

        await client.whenReady();
        // The app resolves identity — the store is attached — but the first
        // probe has not started yet. A `useQuery` that mounts ahead of the auth
        // gate lands exactly here, as does `hydrateOnStart`'s reseed.
        getIdentityStore(client);

        expect(client.replayIdentityVerdict(null)).toBe("unknown");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();

        await settle();

        expect(seeded).toBeUndefined();

        client.close();
    });

    it("refuses a null-stamped cache entry AFTER a probe failed to answer", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await seedNullStampedCache(queryCache);

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async (input: unknown) => {
                if (String(input).includes("get-session")) {
                    throw new TypeError("network down");
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
        await settle();

        // The probe is over and named nobody. That is not the same as being
        // told there is no session — the next probe may still say `subj:<id>`.
        expect(client.replayIdentityVerdict(null)).toBe("unknown");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();

        await settle();

        expect(seeded).toBeUndefined();

        client.close();
    });

    it("still treats a no-auth client's null as a settled identity", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await seedNullStampedCache(queryCache);

        sockets.length = 0;

        // The control the gate must not swallow: an app with no auth at all
        // never resolves an identity, and its `null` is nobody else's.
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

        expect(client.replayIdentityVerdict(null)).toBe("match");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toStrictEqual([{ _id: "t1", text: "A's private message" }]);

        client.close();
    });

    it("settles on a server answer of no session, reopening both gates", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch(null),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        getIdentityStore(client).subscribe(() => undefined);
        await settle();

        expect(client.currentIdentity()).toBeNull();
        expect(client.replayIdentityVerdict(null)).toBe("match");

        client.close();
    });
});

describe("f4 — an identity eviction and shape subscriptions", () => {
    it("clears the previous user's rowset and its resume checkpoint", async () => {
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

        const seen: Record<string, unknown>[][] = [];

        client.subscribeShape({ args: { channelId: "c1" }, name: "messagesByChannel" }, (rows) => seen.push(rows));

        const socket = sockets.at(-1);

        socket?.open();

        const shapeId = socket?.sent.find((message) => message.type === "shape_subscribe")?.id as string;

        socket?.receive({ epoch: "e1", pokeId: "p1", type: "pokeStart" });
        socket?.receive({
            pokeId: "p1",
            rowsPatch: [{ key: "m1", op: "insert", table: "messages", value: { _id: "m1", text: "A's private message" } }],
            shapeId,
            type: "pokePart",
        });
        socket?.receive({ checkpoint: 5, epoch: "e1", pokeId: "p1", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "m1", text: "A's private message" }]);

        // B signs in on the same client.
        client.setAuthToken("tok-b", "user-b");

        // A's rows must come off screen, exactly as an ordinary subscription's do.
        expect(seen.at(-1)).toStrictEqual([]);

        // And the reconnect must NOT resume from A's checkpoint: a
        // `sinceCheckpoint` resume under B's credential asks the server for the
        // diff since a cursor B's view was never at, so B's first frame is a
        // patch onto A's rowset. Wait out the 250ms reconnect backoff first —
        // reading the retired socket's own cold subscribe would pass vacuously.
        await settle();

        const reconnected = sockets.at(-1);

        expect(reconnected).not.toBe(socket);

        reconnected?.open();

        const resume = reconnected?.sent.find((message) => message.type === "shape_subscribe");

        expect(resume).toBeDefined();
        expect(resume).not.toHaveProperty("sinceCheckpoint");
        expect(resume).not.toHaveProperty("sinceEpoch");

        // And the replacement socket is a live one, not a retired one's
        // successor: B's re-seed has to reach the shape, or the eviction traded
        // a leak for a permanently deaf subscription.
        reconnected?.receive({ epoch: "e2", pokeId: "p2", type: "pokeStart" });
        reconnected?.receive({
            pokeId: "p2",
            reset: true,
            rowsPatch: [{ key: "m9", op: "insert", table: "messages", value: { _id: "m9", text: "B's own message" } }],
            shapeId,
            type: "pokePart",
        });
        reconnected?.receive({ checkpoint: 1, epoch: "e2", pokeId: "p2", type: "pokeEnd" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "m9", text: "B's own message" }]);

        client.close();
    });
});

describe("f5 — a frame already queued on a retired socket", () => {
    it("is not delivered to the identity that replaced it", () => {
        expect.assertions(3);

        sockets.length = 0;

        const client = new LunoraClient({
            fetch: cookieSessionFetch({ email: "a@b.co", id: "user-a" }),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            // A real browser's `close()` returns before the `close` event fires,
            // so `conn.socket` still points at the retired socket meanwhile.
            WebSocket: createMockWebSocket(true),
        });

        client.setAuthToken("tok-a", "user-a");

        const seen: unknown[] = [];

        client.subscribe(fnRef("todos.list"), {}, (value) => seen.push(value));

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 4, data: [{ _id: "t1", text: "A's private row" }], id: subscribeId, type: "data" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "t1", text: "A's private row" }]);

        // B signs in: the socket is closed and every subscription blanked.
        client.setAuthToken("tok-b", "user-b");

        expect(seen.at(-1)).toBeUndefined();

        // A frame A's socket had already put on the wire lands now.
        socket?.receive({ cursor: 5, data: [{ _id: "t2", text: "A's second private row" }], id: subscribeId, type: "data" });

        expect(seen.at(-1)).toBeUndefined();

        socket?.flushClose();
        client.close();
    });

    it("keeps delivering on the live socket a plain sign-in deliberately leaves open", () => {
        expect.assertions(2);

        sockets.length = 0;

        // Signing in from signed-out has no previous identity to retire, and
        // bouncing there would cost a reconnect on the most common auth
        // transition there is — so the socket stays, pinned to the `null` it
        // was upgraded under while the live fingerprint moves on. Refusing its
        // frames on THAT mismatch silently freezes every query on a socket
        // nothing will ever replace.
        const client = new LunoraClient({
            fetch: cookieSessionFetch(null),
            heartbeatIntervalMs: 0,
            persistence: false,
            url: "http://app.test",
            WebSocket: createMockWebSocket(true),
        });

        const seen: unknown[] = [];

        client.subscribe(fnRef("todos.list"), {}, (value) => seen.push(value));

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        client.setAuthToken("tok-a", "user-a");

        expect(socket?.closed).toBe(false);

        socket?.receive({ cursor: 1, data: [{ _id: "t1", text: "their own row" }], id: subscribeId, type: "data" });

        expect(seen.at(-1)).toStrictEqual([{ _id: "t1", text: "their own row" }]);

        client.close();
    });
});
