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
});
