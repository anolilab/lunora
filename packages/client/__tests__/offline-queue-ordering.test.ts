import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * FIFO across the offline queue and the live socket.
 *
 * A write queued offline can be HELD at flush time — `replayGateVerdict`
 * returns `"hold"` while a sticky subject labels a credential the session has
 * not re-confirmed. A held queue leaves no entry in `offlineFlushes`, so the
 * ordering barrier at the top of `mutation()` sees nothing to wait for: a
 * later write to the same document went out live over the open socket and
 * landed BEFORE the older queued one, and last-writer-wins resurrected the
 * older value.
 *
 * The server's observed order is what these assert — not merely that both
 * writes arrived.
 */

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

interface MockSocket {
    open: () => void;
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
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
            // The writes under test ride HTTP, not the socket — recorded only so
            // a frame the client sends is observable if a test needs it.
            this.sent.push(raw);
        }

        private emit(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** Every write marker the server saw, in the order the requests reached it. */
const MARKERS = /OLDER|NEWER|LIVE|REPLAYED/g;

/**
 * Records the order the server observed across both replay transports — the
 * single-call `/rpc` path and the batched `/_lunora/rpc-batch` path. Scanning
 * the raw body keeps the assertion on the ORDER rather than on either path's
 * envelope shape.
 */
const createServer = (): { fetch: typeof fetch; observed: string[] } => {
    const observed: string[] = [];

    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
        // The session probe the hold path re-issues — keep it failing so the
        // subject stays unconfirmed and the queue stays held.
        if (url.includes("get-session")) {
            return Response.json({ error: "nope" }, { status: 401 });
        }

        const raw = typeof init?.body === "string" ? init.body : "{}";

        for (const match of raw.matchAll(MARKERS)) {
            observed.push(match[0]);
        }

        const body = JSON.parse(raw) as { calls?: unknown[] };

        if (body.calls) {
            return Response.json(
                {
                    results: body.calls.map((_, id) => {
                        return { body: { result: { ok: true } }, id };
                    }),
                },
                { status: 200 },
            );
        }

        return Response.json({ result: { ok: true } }, { status: 200 });
    });

    return { fetch: fetchImpl as unknown as typeof fetch, observed };
};

describe("offline queue ordering vs a live mutation", () => {
    it("sends a live write behind an older write held for subject re-confirmation", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.setAuthToken("jwt-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        // A — written offline, queued under `user-1`.
        const older = client.mutation(fnRef("todos.set"), { text: "OLDER" });
        const olderOutcome = older.then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await settle();

        // The JWT is refreshed while offline. The subject is sticky, so the
        // label still says `user-1` — but it has not been checked against the
        // new credential, so every replay verdict is `"hold"`.
        client.setAuthToken("jwt-2");

        // Back online: the flush drains A, holds it, and re-queues it. No
        // barrier is left behind in `offlineFlushes`.
        sockets.at(-1)?.open();
        await settle();

        expect(server.observed).toStrictEqual([]);

        // B — issued while the socket is open, but A is still held. It must go
        // BEHIND A rather than out live; the cost of that choice is that B does
        // not settle until the hold lifts, which is asserted here too.
        const newer = client.mutation(fnRef("todos.set"), { text: "NEWER" });
        const newerOutcome = newer.then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await settle();

        expect(server.observed).toStrictEqual([]);

        // The session finally resolves; both writes replay, oldest first.
        client.setAuthToken("jwt-2", "user-1");
        await settle();

        await expect(olderOutcome).resolves.toBe("committed");
        await expect(newerOutcome).resolves.toBe("committed");
        expect(server.observed).toStrictEqual(["OLDER", "NEWER"]);
    });

    it("still sends a live write directly when nothing is queued for the shard", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.setAuthToken("jwt-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        await settle();

        await client.mutation(fnRef("todos.set"), { text: "LIVE" });

        expect(server.observed).toStrictEqual(["LIVE"]);
    });

    it("does not re-queue a durable replay that re-enters with its original mutation id", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const client = new LunoraClient({
            fetch: server.fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence: createInMemoryPersistence(),
            url: "http://app.test",
            WebSocket: createMockWebSocket(sockets),
        });

        client.setAuthToken("jwt-1", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const held = client.mutation(fnRef("todos.set"), { text: "HELD" });

        held.catch(() => undefined);
        await settle();

        client.setAuthToken("jwt-2");
        sockets.at(-1)?.open();
        await settle();

        // The `@lunora/db` outbox replays by calling back into `mutation()` with
        // the write's original key. It is already durable — the gate must let it
        // through rather than loop it back into the queue it is draining.
        await client.mutation(fnRef("todos.set"), { text: "REPLAYED" }, { mutationId: "outbox:1" });

        expect(server.observed).toStrictEqual(["REPLAYED"]);
    });
});
