import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * A durable write queued while offline replays on the shard socket's `open`
 * handler, with whatever bearer the client was holding when it went offline.
 * Over a long disconnect that token has usually expired, and the HTTP replay
 * path has no equivalent of the WS `4001` / `TOKEN_EXPIRED` close frame — so a
 * `401` used to settle the write TERMINALLY: unpersisted, rejected, gone. A
 * write hydrated after a reload has a no-op rejecter, so nothing told the app.
 *
 * The credential, not the write, is what was refused. These drive the real
 * client through the real outbox to assert the write is HELD instead, the
 * token-expired hook fires, and the refreshed credential commits it.
 */

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

interface MockSocket {
    open: () => void;
    url: string;
}

const sockets: MockSocket[] = [];

const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readonly url: string;

        public readyState = 0;

        private readonly sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                url,
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
            // The replay under test rides HTTP, not the socket — recorded only
            // so a frame the client sends is observable if a test needs it.
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

const unauthorizedResponse = (): Response =>
    Response.json({ error: { code: "UNAUTHORIZED", message: "token expired" } }, { headers: { "content-type": "application/json" }, status: 401 });

const okResponse = (): Response => Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });

describe("durable replay under an expired bearer", () => {
    it("holds the write, notifies onTokenExpired, and commits it once the token is refreshed", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => unauthorizedResponse());
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: fetchImpl as unknown as typeof fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });

        const settled: { code?: string; status: string }[] = [];

        client.onMutationSettled((event) => {
            settled.push({ code: (event.error as { code?: string } | undefined)?.code, status: event.status });
        });

        const expired = vi.fn<() => void>();

        client.onTokenExpired(expired);

        client.setAuthToken("jwt-issued-before-going-offline", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const pending = client.mutation(fnRef("todos.add"), { text: "written offline" });
        // The write must not reject; a floating rejection would fail the run.
        const outcome = pending.then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await settle();

        await expect(persistence.load()).resolves.toHaveLength(1);

        // Back online: the `open` handler flushes with the stale bearer.
        sockets.at(-1)?.open();
        await settle();

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(settled).toStrictEqual([]);
        await expect(persistence.load()).resolves.toHaveLength(1);
        expect(expired).toHaveBeenCalledTimes(1);

        // The refresh the hook asks for: a fresh credential re-flushes the queue.
        fetchImpl.mockImplementation(async () => okResponse());
        client.setAuthToken("refreshed-jwt", "user-1");
        await settle();

        await expect(outcome).resolves.toBe("committed");
        expect(settled).toStrictEqual([{ code: undefined, status: "committed" }]);
        await expect(persistence.load()).resolves.toHaveLength(0);
        expect(fetchImpl.mock.calls.at(-1)?.[1].headers).toMatchObject({
            authorization: "Bearer refreshed-jwt" /* gitleaks:allow -- test fixture, not a real credential */,
        });

        client.close();
    });
});
