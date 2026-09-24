import { describe, expect, it, vi } from "vitest";

import { getIdentityStore } from "../src/auth";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import { createInMemoryQueryCache, queryCacheKey } from "../src/query-cache";
import type { FunctionReference } from "../src/types";

/**
 * The identity SUBJECT, end to end through the code adapters actually run.
 *
 * `setAuthToken`'s sticky-`subject` contract is what keeps a routine JWT refresh
 * from reading as a user switch. No shipped adapter ever passed one — every one
 * calls `setAuthToken(token)` — so the whole re-stamp path was unreachable in
 * production and a refresh discarded the user's own queued writes and read
 * cache. The subject is now established by `getCurrentUser()`, the one call
 * every adapter's identity store already makes, so these drive that store (the
 * framework-neutral one every adapter mirrors) rather than calling
 * `setAuthToken(token, subject)` by hand — the shape that made the old unit
 * tests pass over an inert feature.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const flushMicrotasks = (): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, 0);
    });

const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await flushMicrotasks();
    }
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

interface MockSocket {
    open: () => void;
    receive: (payload: unknown) => void;
    sent: string[];
    url: string;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        public sent: string[] = [];

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
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            this.dispatch("message", { data: JSON.stringify(payload) });
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public close(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const urlOf = (input: Parameters<typeof fetch>[0]): string => (input instanceof Request ? input.url : String(input));

/** A `fetch` double that answers `get-session` with whichever user the given token belongs to, and every RPC with `ok`. */
const createFetchMock = (usersByToken: Record<string, string>) =>
    vi.fn<typeof fetch>(async (input, init) => {
        if (urlOf(input).includes("get-session")) {
            const authorization = ((init?.headers ?? {}) as Record<string, string>)["authorization"] ?? "";
            const id = usersByToken[authorization.replace("Bearer ", "")];

            return jsonResponse(id === undefined ? undefined : { user: { id } });
        }

        return jsonResponse({ result: { ok: true } });
    });

const rpcCalls = (fetchMock: ReturnType<typeof createFetchMock>): string[] =>
    fetchMock.mock.calls.filter(([url]) => !urlOf(url).includes("get-session")).map(([, init]) => (init as { body?: string }).body ?? "");

describe("auth identity subject", () => {
    it("keys the offline identity on the resolved user id, through the identity store every adapter uses", async () => {
        expect.assertions(2);

        const fetchMock = createFetchMock({ "jwt-1": "user-1" });
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        getIdentityStore(client).subscribe(() => undefined);

        // What every shipped adapter's `setToken` does — no subject argument.
        client.setAuthToken("jwt-1");

        // Before the session resolves the identity can only be the token hash.
        expect(client.currentIdentity()).not.toBe("subj:user-1");

        await settle();

        expect(client.currentIdentity()).toBe("subj:user-1");

        client.close();
    });

    it("keeps a queued write and the identity across a routine token refresh", async () => {
        expect.assertions(4);

        const fetchMock = createFetchMock({ "jwt-1": "user-1", "jwt-2": "user-1" });
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: fetchMock,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        getIdentityStore(client).subscribe(() => undefined);
        client.setAuthToken("jwt-1");
        await settle();

        const settled: string[] = [];

        client.onMutationSettled((event) => settled.push(event.status));

        client.mutation(fnRef("posts:create"), { title: "mine" }).catch(() => undefined);
        await settle();

        const queued = await persistence.load();

        expect(queued.map((record) => record.identity)).toEqual(["subj:user-1"]);

        // The app rotates its JWT — same user, new bytes. This is the call every
        // adapter makes, and the one that used to reject the queue wholesale.
        client.setAuthToken("jwt-2");
        await settle();

        expect(settled).toEqual([]);
        expect(client.currentIdentity()).toBe("subj:user-1");
        await expect(persistence.load()).resolves.toHaveLength(1);

        client.close();
    });

    it("rejects the previous user's queued write on an account switch, and never replays it under the new credential", async () => {
        expect.assertions(4);

        const fetchMock = createFetchMock({ "jwt-1": "user-1", "jwt-2": "user-2" });
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: fetchMock,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        getIdentityStore(client).subscribe(() => undefined);
        client.setAuthToken("jwt-1");
        await settle();

        const settled: string[] = [];

        client.onMutationSettled((event) => settled.push(event.status));

        client.mutation(fnRef("posts:create"), { title: "user-1's" }).catch(() => undefined);
        await settle();

        // Straight to the other account, no sign-out in between. The sticky
        // subject still says user-1 until the session resolve says otherwise —
        // the window in which the write must NOT go out under jwt-2.
        client.setAuthToken("jwt-2");

        expect(rpcCalls(fetchMock)).toEqual([]);

        await settle();

        expect(client.currentIdentity()).toBe("subj:user-2");
        expect(settled).toEqual(["rejected"]);
        await expect(persistence.load()).resolves.toEqual([]);

        client.close();
    });

    it("clears the subject when the token is cleared, so the next sign-in does not inherit it", async () => {
        expect.assertions(2);

        const fetchMock = createFetchMock({ "jwt-1": "user-1" });
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        getIdentityStore(client).subscribe(() => undefined);
        client.setAuthToken("jwt-1");
        await settle();

        client.setAuthToken(null);

        expect(client.currentIdentity()).toBeNull();

        // A different user signs in on this device. Without clearing, the sticky
        // "subj:user-1" would survive and hand them user-1's queue and cache.
        client.setAuthToken("jwt-other");

        expect(client.currentIdentity()).not.toBe("subj:user-1");

        client.close();
    });

    it("files reads cached after a late subject resolve under the subject, not the socket's boot-time token hash", async () => {
        expect.assertions(1);

        sockets.length = 0;

        const fetchMock = createFetchMock({ "jwt-1": "user-1" });
        const queryCache = createInMemoryQueryCache();
        const client = new LunoraClient({
            fetch: fetchMock,
            queryCache,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        getIdentityStore(client).subscribe(() => undefined);
        client.setAuthToken("jwt-1");

        // The socket opens on the token hash — the session resolve lands after.
        client.subscribe(fnRef("messages:list"), {}, () => undefined);
        sockets.at(-1)?.open();
        await settle();

        const socket = sockets.at(-1);
        const subscribeFrame = socket?.sent.map((raw) => JSON.parse(raw) as { id?: string; type: string }).find((frame) => frame.type === "subscribe");

        socket?.receive({ cursor: 1, data: [{ _id: "m1" }], id: subscribeFrame?.id, type: "data" });

        // Past the read-cache write debounce.
        await new Promise((resolve) => {
            setTimeout(resolve, 400);
        });

        // Next session establishes `subj:user-1` before any socket opens; a stale
        // token-hash stamp here means every cached read is discarded, silently.
        const stored = await queryCache.load();
        const cached = stored.find((entry) => entry.key === queryCacheKey("messages:list", "{}"));

        expect(cached?.identity).toBe("subj:user-1");

        client.close();
    });

    it("bounds the cached mutator watermarks by identity, keeping the most recent", async () => {
        expect.assertions(2);

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ lastMutationId: 1, result: "ok" }));
        const client = new LunoraClient({ fetch: fetchMock, url: "https://app.example", WebSocket: createMockWebSocket() });

        for (let index = 0; index < 10; index += 1) {
            client.setAuthToken(`token-${String(index)}`, `user-${String(index)}`);
            // eslint-disable-next-line no-await-in-loop -- each identity's ack must land before the next
            await client.callMutator("messages:send", {}, { clientSeq: 1 });
        }

        // The 8-identity bound evicted the oldest; the most recent still resolves.
        client.setAuthToken("token-0", "user-0");

        expect(client.confirmedMutationWatermark()).toBe(0);

        client.setAuthToken("token-9", "user-9");

        expect(client.confirmedMutationWatermark()).toBe(1);

        client.close();
    });
});
