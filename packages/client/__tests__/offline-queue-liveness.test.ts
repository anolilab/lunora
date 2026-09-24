import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MutationSettledEvent } from "../src/lunora-client";
import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * Liveness of a queue every entry of which is HELD.
 *
 * `replayGateVerdict` holds a write while a sticky subject labels a credential
 * the session has not re-confirmed, and the drain's one best-effort
 * `getCurrentUser()` is the only thing that can lift the hold. Over a socket
 * that stays open, a `/get-session` that fails once used to end the story: the
 * drain returned before scheduling anything, and only a reconnect or an explicit
 * `setAuthToken(token, subject)` would ever try again — so a transiently failing
 * session endpoint wedged the durable writes for the whole session.
 */

const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

/** Drain pending microtasks and any timer due now. */
const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await vi.advanceTimersByTimeAsync(0);
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

/** Every write marker the server saw, plus how often the session endpoint was probed. */
const MARKERS = /OLDER|NEWER/g;

const createServer = (): { fetch: typeof fetch; observed: string[]; sessionOk: { value: boolean }; sessionProbes: () => number } => {
    const observed: string[] = [];
    const sessionOk = { value: false };
    let probes = 0;

    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
        if (url.includes("get-session")) {
            probes += 1;

            return sessionOk.value ? Response.json({ user: { id: "user-1" } }, { status: 200 }) : Response.json({ error: "nope" }, { status: 401 });
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

    return { fetch: fetchImpl as unknown as typeof fetch, observed, sessionOk, sessionProbes: () => probes };
};

/** A client whose queue holds one write, with the socket open and the session endpoint failing. */
const createHeldClient = async (server: ReturnType<typeof createServer>): Promise<{ client: LunoraClient; outcome: Promise<string> }> => {
    const sockets: MockSocket[] = [];
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

    const older = client.mutation(fnRef("todos.set"), { text: "OLDER" });
    const outcome = older.then(
        () => "committed",
        (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
    );

    await settle();

    // The JWT is refreshed while offline: the subject label is sticky, so every
    // replay verdict is `"hold"` until a session resolve re-confirms it.
    client.setAuthToken("jwt-2");

    sockets.at(-1)?.open();
    await settle();

    return { client, outcome };
};

describe("offline queue liveness while every entry is held", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("drains once the session endpoint recovers, with no reconnect and no setAuthToken", async () => {
        expect.hasAssertions();

        const server = createServer();
        const { client, outcome } = await createHeldClient(server);

        // Wedged: held, nothing sent, and the socket that would re-trigger a
        // flush is healthy and staying up.
        expect(server.observed).toStrictEqual([]);
        expect(client.pendingCount()).toBe(1);

        // The session endpoint recovers. Nothing else changes — no reconnect,
        // no `setAuthToken`, no new mutation.
        server.sessionOk.value = true;

        await vi.advanceTimersByTimeAsync(5000);
        await settle();

        expect(server.observed).toStrictEqual(["OLDER"]);
        await expect(outcome).resolves.toBe("committed");
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("keeps a write that never re-confirms queued, re-probing on a backoff rather than hammering", async () => {
        expect.hasAssertions();

        const server = createServer();
        const { client, outcome } = await createHeldClient(server);
        const settled = vi.fn<(event: MutationSettledEvent) => void>();

        client.onMutationSettled(settled);

        // Five minutes of a session endpoint that never recovers.
        await vi.advanceTimersByTimeAsync(300_000);
        await settle();

        // The write is neither sent nor dropped: it stays durable and queued,
        // and `pendingCount()` is what surfaces the stall to the app.
        expect(server.observed).toStrictEqual([]);
        expect(settled).not.toHaveBeenCalled();
        expect(client.pendingCount()).toBe(1);

        // Backoff, not a hot loop: 1s doubling to the 60s ceiling, equal-jittered,
        // fits at most 14 retries into five minutes (every delay at its 0.5
        // floor) plus the initial drain's own probe. An unbacked-off retry would
        // be orders of magnitude more.
        expect(server.sessionProbes()).toBeLessThanOrEqual(15);
        expect(server.sessionProbes()).toBeGreaterThan(2);

        client.close();
        outcome.catch(() => undefined);
    });
});
