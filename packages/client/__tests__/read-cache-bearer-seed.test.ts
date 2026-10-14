import { describe, expect, it } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryQueryCache } from "../src/query-cache";
import type { FunctionReference, QueryCacheAdapter } from "../src/types";

/**
 * The durable read cache across a reload, for the only auth shape the adapters
 * actually produce.
 *
 * A cache entry is stamped with the identity fingerprint, which settles on the
 * resolved subject (`subj:<id>`) once `/get-session` answers. But every adapter
 * (`react`, `vue`, `svelte`, `solid`, `angular`) sets the token from storage
 * FIRST and learns the subject a round trip later — so on the next reload the
 * gate was asked `"<len>:<hash>" === "subj:<id>"`, said no, and dropped the
 * entry. The feature was inert for every bearer-token app: blank panels on
 * reload, and nothing at all on an offline cold start, where the subject never
 * resolves.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 40);
        });
    }
};

interface MockSocket {
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

        public constructor(url: string) {
            this.url = url;
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                receive: (payload: unknown) => {
                    this.emit("message", { data: JSON.stringify(payload) });
                },
                sent: this.sent,
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
            this.sent.push(JSON.parse(raw));
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const makeClient = (queryCache: QueryCacheAdapter): LunoraClient =>
    new LunoraClient({
        fetch: async () => Response.json({}),
        heartbeatIntervalMs: 0,
        hydrateOnStart: true,
        persistence: false,
        queryCache,
        url: "http://app.test",
        WebSocket: createMockWebSocket(),
    });

/** Session 1: a tab that subscribed, resolved its session, and cached a server frame. */
const writeCache = async (queryCache: QueryCacheAdapter, token: string): Promise<void> => {
    sockets.length = 0;

    const client = makeClient(queryCache);

    await client.whenReady();
    client.setAuthToken(token);
    client.subscribe(fnRef("todos.list"), {}, () => {});

    const socket = sockets.at(-1);

    socket?.open();

    const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

    // What `adoptResolvedSubject` does once `/get-session` answers.
    client.setAuthToken(token, "user-1");
    socket?.receive({ cursor: 7, data: [{ _id: "t1", text: "cached row" }], id: subscribeId, type: "data" });

    await settle();

    client.close();
};

describe("durable read cache on a bearer-token reload", () => {
    it("seeds a subscription from an entry stamped with the resolved subject when only the token is known", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        const stored = await queryCache.load();

        expect(stored.map((entry) => entry.identity)).toStrictEqual(["subj:user-1"]);

        // Session 2 (reload): the adapter restores the SAME token from storage;
        // the subject is still a `/get-session` away.
        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-abc");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toStrictEqual([{ _id: "t1", text: "cached row" }]);

        client.close();
    });

    it("re-seeds an open subscription when the subject resolves after a token refresh", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        // Session 2 with a REFRESHED credential: neither the fingerprint nor the
        // token matches, so nothing can be decided at `subscribe()` time — but
        // the entry must survive to be seeded once the subject settles it.
        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-refreshed");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();

        client.setAuthToken("tok-refreshed", "user-1");

        expect(seeded).toStrictEqual([{ _id: "t1", text: "cached row" }]);
        expect(client.peekActiveQuerySnapshot("todos.list", {})).toStrictEqual({ present: true, value: [{ _id: "t1", text: "cached row" }] });

        client.close();
    });

    /**
     * The other side of the same relabel: the sticky subject rides onto a token
     * nothing has checked it against — `setAuthToken(token)` with no subject,
     * which is what every adapter does on a reload, and what a switched account
     * looks like from here. The fingerprint still reads `subj:user-1`, so an
     * entry stamped with it matched on the label alone and handed the NEW
     * account the previous account's cached rows.
     */
    it("refuses an entry stamped with a subject the credential in hand was never checked against", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-abc", "user-1");
        client.setAuthToken("tok-second-account");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();
        expect(client.peekHydratedQuery("todos.list", {})).toBeUndefined();

        client.close();
    });

    it("takes an already-seeded value back off screen for as long as the subject is unconfirmed", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-abc");

        const seen: unknown[] = [];

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seen.push(value);
        });

        // Seeded by credential, then relabelled onto the resolved subject.
        expect(seen.at(-1)).toStrictEqual([{ _id: "t1", text: "cached row" }]);

        client.setAuthToken("tok-abc", "user-1");
        // The reload/switch: another credential under the same sticky label. The
        // value on screen came from the cache, so it goes back to the cache.
        client.setAuthToken("tok-second-account");

        expect(seen.at(-1)).toBeUndefined();
        expect(client.peekActiveQuerySnapshot("todos.list", {})).toStrictEqual({ present: true, value: undefined });
        expect(client.peekHydratedQuery("todos.list", {})).toBeUndefined();

        // ...and comes back once the session resolve says the new credential is
        // that same user's after all (a plain token refresh).
        client.setAuthToken("tok-second-account", "user-1");

        expect(seen.at(-1)).toStrictEqual([{ _id: "t1", text: "cached row" }]);

        client.close();
    });

    it("still refuses an entry cached by a different credential", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("someone-elses-token", "user-2");

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();
        expect(client.peekHydratedQuery("todos.list", {})).toBeUndefined();

        client.close();
    });

    /**
     * Navigating away from a route and back, offline. The hydrated entry was
     * one-shot per key: `subscribe()` consumed it, the last unsubscribe dropped
     * the state that held its value, and nothing re-seeded — so the remount
     * rendered `undefined` for the rest of the offline session while the durable
     * store still held the rows. React masked it behind TanStack's `gcTime`;
     * every other adapter showed it on the first navigation.
     */
    it("seeds again when a route remounts after its last subscriber detached", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-abc");

        let first: unknown;

        const unsubscribe = client.subscribe(fnRef("todos.list"), {}, (value) => {
            first = value;
        });

        expect(first).toStrictEqual([{ _id: "t1", text: "cached row" }]);

        // Navigate away: the last subscriber detaches and the state is removed.
        unsubscribe();

        // Navigate back, still offline — no socket has delivered anything.
        let second: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            second = value;
        });

        expect(second).toStrictEqual([{ _id: "t1", text: "cached row" }]);
        expect(client.peekActiveQuerySnapshot("todos.list", {})).toStrictEqual({ present: true, value: [{ _id: "t1", text: "cached row" }] });

        client.close();
    });

    /** The other half of the same move: a seed a server frame has replaced must never come back. */
    it("does not replay a seed a server frame has superseded", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        await writeCache(queryCache, "tok-abc");

        sockets.length = 0;

        const client = makeClient(queryCache);

        await client.whenReady();
        client.setAuthToken("tok-abc");

        let live: unknown;

        const unsubscribe = client.subscribe(fnRef("todos.list"), {}, (value) => {
            live = value;
        });

        const socket = sockets.at(-1);

        socket?.open();

        const subscribeId = socket?.sent.find((message) => message.type === "subscribe")?.id;

        socket?.receive({ cursor: 9, data: [{ _id: "t2", text: "fresh row" }], id: subscribeId, type: "data" });

        expect(live).toStrictEqual([{ _id: "t2", text: "fresh row" }]);

        unsubscribe();

        let remounted: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            remounted = value;
        });

        expect(remounted).toBeUndefined();
        expect(client.peekHydratedQuery("todos.list", {})).toBeUndefined();

        client.close();
    });
});

/**
 * A cookie session has no client-held credential: the cookie is `HttpOnly`, so
 * the client can neither read it nor prove it still holds it, and offline
 * `/get-session` never answers. Entries are therefore cached under `subj:<id>`
 * with no `credential`, and the identity gate has nothing to match them
 * against.
 *
 * That is the documented limitation, not an oversight — seeding on a persisted
 * subject label would hand the rows to whoever opens the browser profile, with
 * no evidence they are that subject. Revoking on a later mismatch does not
 * close it: the check can only run once connectivity returns, which is exactly
 * the state where the offline seed was not needed. Offline-first READS require
 * a bearer token.
 */
describe("durable read cache on a cookie-session cold start", () => {
    it("refuses to seed when nothing on this client can evidence the cached identity", async () => {
        expect.hasAssertions();

        const queryCache = createInMemoryQueryCache();

        // Session 1: a cookie session — no bearer token was ever set, the
        // subject arrived from `/get-session`.
        sockets.length = 0;

        const writer = makeClient(queryCache);

        await writer.whenReady();
        writer.subscribe(fnRef("todos.list"), {}, () => {});

        const writeSocket = sockets.at(-1);

        writeSocket?.open();

        const subscribeId = writeSocket?.sent.find((message) => message.type === "subscribe")?.id;

        writer.setAuthToken(null, "user-1");
        writeSocket?.receive({ cursor: 7, data: [{ _id: "t1", text: "cached row" }], id: subscribeId, type: "data" });

        await settle();

        writer.close();

        const stored = await queryCache.load();

        expect(stored.map((entry) => [entry.identity, entry.credential])).toStrictEqual([["subj:user-1", undefined]]);

        // Session 2: an offline cold start. No token to restore, and
        // `/get-session` cannot be reached.
        sockets.length = 0;

        const client = new LunoraClient({
            fetch: async () => {
                throw new Error("offline");
            },
            heartbeatIntervalMs: 0,
            hydrateOnStart: true,
            persistence: false,
            queryCache,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        await client.whenReady();

        let seeded: unknown;

        client.subscribe(fnRef("todos.list"), {}, (value) => {
            seeded = value;
        });

        expect(seeded).toBeUndefined();
        expect(client.peekHydratedQuery("todos.list", {})).toBeUndefined();

        // `getCurrentUser()` REJECTS here rather than resolving `null`: an
        // unreachable endpoint is not the same answer as "you are signed out",
        // and collapsing the two made an offline reload with a valid stored
        // token read as a sign-out in every adapter's auth gate. The property
        // this case pins is the refusal to seed above — the identity call is
        // asserted only to show the client still learns nothing about the
        // cached subject, which is why it cannot evidence it.
        await expect(client.getCurrentUser()).rejects.toThrow("offline");

        client.close();
    });
});
