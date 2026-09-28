import { createWorker } from "@lunora/runtime";
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

const unauthenticatedResponse = (): Response =>
    Response.json({ error: { code: "UNAUTHENTICATED", message: "token expired" } }, { headers: { "content-type": "application/json" }, status: 401 });

const okResponse = (): Response => Response.json({ result: { ok: true } }, { headers: { "content-type": "application/json" }, status: 200 });

describe("durable replay under an expired bearer", () => {
    it("holds the write, notifies onTokenExpired, and commits it once the token is refreshed", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () => unauthenticatedResponse());
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

    // `UNAUTHORIZED` is the app's own "you may not do this" (`throw new
    // LunoraError("UNAUTHORIZED", "Sign in to post")`): a verdict on the write,
    // which no refresh changes. Holding it stranded the write, and asked an app
    // that may hold no token at all to refresh one.
    it("settles a write the app refused UNAUTHORIZED instead of holding it for a refresh", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
            Response.json({ error: { code: "UNAUTHORIZED", message: "you are not playing in this game" } }, { status: 401 }),
        );
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
        const expired = vi.fn<() => void>();

        client.onMutationSettled((event) => {
            settled.push({ code: (event.error as { code?: string } | undefined)?.code, status: event.status });
        });
        client.onTokenExpired(expired);
        client.setAuthToken("jwt", "user-1");
        client.subscribe(fnRef("games.get"), {}, () => {});

        const outcome = client.mutation(fnRef("games.move"), { to: "e4" }).then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await settle();
        sockets.at(-1)?.open();
        await settle();

        expect(settled).toStrictEqual([{ code: "UNAUTHORIZED", status: "rejected" }]);
        await expect(outcome).resolves.toBe("rejected:UNAUTHORIZED");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(expired).not.toHaveBeenCalled();
        await expect(persistence.load()).resolves.toHaveLength(0);

        client.close();
    });
});

describe("durable replay against a real worker under a lapsed bearer", () => {
    it("is refused with TOKEN_EXPIRED before the shard runs it, held, and committed after setAuthToken", async () => {
        expect.hasAssertions();

        sockets.length = 0;

        const nowSeconds = Math.floor(Date.now() / 1000);
        const shardCalls: string[] = [];
        // The resolver an app ships for its JWTs: it verifies the token and hands
        // back the identity WITH its `exp`, lapsed or not.
        const worker = createWorker({
            resolveIdentity: (request) => {
                const bearer = request.headers.get("authorization");

                if (bearer === null) {
                    return null;
                }

                return { exp: bearer === "Bearer stale-jwt" ? nowSeconds - 60 : nowSeconds + 3600, userId: "user-1" };
            },
            shardDO: {
                get: () => {
                    return {
                        fetch: async (request: Request) => {
                            shardCalls.push(request.headers.get("authorization") ?? "");

                            return okResponse();
                        },
                    };
                },
                idFromName: (name) => name,
            },
        });
        const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url, init) =>
            worker.fetch(new Request(url, init), {}, { passThroughOnException: () => undefined, waitUntil: () => undefined }),
        );
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: fetchImpl as unknown as typeof fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const expired = vi.fn<() => void>();

        client.onTokenExpired(expired);
        client.setAuthToken("stale-jwt", "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const outcome = client.mutation(fnRef("todos.add"), { text: "written offline" }).then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await settle();
        sockets.at(-1)?.open();
        await settle();

        // Refused at the worker: the lapsed credential never ran the write.
        expect(shardCalls).toStrictEqual([]);
        await expect(persistence.load()).resolves.toHaveLength(1);
        expect(expired).toHaveBeenCalledTimes(1);

        client.setAuthToken("fresh-jwt", "user-1");
        await settle();

        await expect(outcome).resolves.toBe("committed");
        expect(shardCalls).toStrictEqual(["Bearer fresh-jwt"]);
        await expect(persistence.load()).resolves.toHaveLength(0);

        client.close();
    });
});

// A cookie (or Access edge) session keeps `authToken` at `null` across its
// refresh, so neither `setAuthToken` nor a changed bearer ever re-flushes the
// queue: a write refused for the lapsed cookie sat queued until the next
// reconnect, which a healthy socket never makes.
describe("durable replay under an expired cookie session", () => {
    it("re-sends a refused write on a backoff with the refreshed cookie, asking the app to refresh once", async () => {
        expect.hasAssertions();

        vi.useFakeTimers();
        sockets.length = 0;

        let cookieFresh = false;
        const rpcCalls: string[] = [];
        const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (url) => {
            if (url.includes("get-session")) {
                return Response.json({ session: { id: "s" }, user: { id: "user-1" } });
            }

            rpcCalls.push(url);

            return cookieFresh ? okResponse() : Response.json({ error: { code: "TOKEN_EXPIRED", message: "authentication token expired" } }, { status: 401 });
        });
        const persistence = createInMemoryPersistence();
        const client = new LunoraClient({
            fetch: fetchImpl as unknown as typeof fetch,
            heartbeatIntervalMs: 0,
            offlineQueue: { queueBeforeFirstConnect: true },
            persistence,
            url: "http://app.test",
            WebSocket: createMockWebSocket(),
        });
        const expired = vi.fn<() => void>();

        client.onTokenExpired(expired);
        client.setAuthToken(null, "user-1");
        client.subscribe(fnRef("todos.list"), {}, () => {});

        const outcome = client.mutation(fnRef("todos.add"), { text: "written offline" }).then(
            () => "committed",
            (error: unknown) => `rejected:${String((error as { code?: string }).code)}`,
        );

        await vi.advanceTimersByTimeAsync(0);
        sockets.at(-1)?.open();
        await vi.advanceTimersByTimeAsync(0);

        expect(rpcCalls).toHaveLength(1);
        expect(expired).toHaveBeenCalledTimes(1);

        // Still expired for a while: re-sent on a backoff, not in a loop, and
        // the app is not asked to refresh again for the same session.
        await vi.advanceTimersByTimeAsync(10_000);

        expect(rpcCalls.length).toBeGreaterThan(1);
        expect(rpcCalls.length).toBeLessThanOrEqual(5);
        expect(expired).toHaveBeenCalledTimes(1);
        await expect(persistence.load()).resolves.toHaveLength(1);

        // The browser's cookie is renewed; nothing on the client changes.
        cookieFresh = true;
        await vi.advanceTimersByTimeAsync(60_000);

        await expect(outcome).resolves.toBe("committed");
        await expect(persistence.load()).resolves.toHaveLength(0);

        client.close();
        vi.useRealTimers();
    });
});
