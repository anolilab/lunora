import { LunoraClient } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraSubscriptionRegistry } from "../src/cache";
import { keyHash } from "../src/query-key";
import type { MockSocket } from "./mock-socket";
import { createMockWebSocket } from "./mock-socket";

const KEY: QueryKey = ["lunora", "posts:list", {}, null];

/** A client with a socket implementation that never pushes: a blocked socket with the polling fallback off. */
const silentClient = {
    expectsPush: () => true,
    getWebSocketImpl: () => WebSocket,
    isCrossTabFollower: () => false,
    onConnectionStatus: () => () => undefined,
} as unknown as LunoraClient;

describe("lunoraSubscriptionRegistry.liveValue", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("falls back to the HTTP fetch when nothing pushes within the wait bound", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const result = registry.liveValue(new QueryClient(), KEY, new AbortController().signal, { fetch: async () => "snapshot" });

        await vi.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toBe("snapshot");
    });

    it("rejects at once for a signal that was already aborted", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const controller = new AbortController();

        controller.abort(new Error("unmounted"));

        await expect(registry.liveValue(new QueryClient(), KEY, controller.signal, { fetch: async () => "snapshot" })).rejects.toThrow("unmounted");
    });

    it("returns a null pushed while the HTTP fallback was in flight, not the snapshot", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const queryClient = new QueryClient();
        const result = registry.liveValue(queryClient, KEY, new AbortController().signal, {
            fetch: async () => {
                // A push lands while the fallback runs: the subscription now holds `null`.
                registry["liveFor"](keyHash(KEY)).state = { status: "pushed", value: null };
                queryClient.setQueryData(KEY, null);

                return "snapshot";
            },
            waitForPush: false,
        });

        await expect(result).resolves.toBeNull();
    });

    it("forgets the live state of a key nothing subscribes to once the HTTP fallback settles", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        await registry.liveValue(new QueryClient(), KEY, new AbortController().signal, { fetch: async () => "snapshot", waitForPush: false });

        expect(registry["live"].size).toBe(0);
    });

    it("forgets the live state of a key nothing subscribes to when the HTTP fallback rejects", async () => {
        expect.assertions(2);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        await expect(
            registry.liveValue(new QueryClient(), KEY, new AbortController().signal, {
                fetch: async () => {
                    throw new Error("offline");
                },
                waitForPush: false,
            }),
        ).rejects.toThrow("offline");

        expect(registry["live"].size).toBe(0);
    });

    it("keeps the live state of a key a subscription still feeds", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        registry["entries"].set(keyHash(KEY), {} as never);

        await registry.liveValue(new QueryClient(), KEY, new AbortController().signal, { fetch: async () => "snapshot", waitForPush: false });

        expect(registry["live"].has(keyHash(KEY))).toBe(true);
    });

    it("fetches over HTTP at once when the socket has already failed to open and nothing polls", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => Response.json({ result: "snapshot" })),
            persistence: false,
            pollingFallback: { intervalMs: 0 },
            queryCache: false,
            reconnect: { initialDelayMs: 60_000, jitter: false, maxDelayMs: 60_000 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(sockets),
        });
        const registry = new LunoraSubscriptionRegistry(client);
        const queryClient = new QueryClient();
        const postsList = { __lunoraRef: "posts:list" };

        try {
            const detach = registry.attach(queryClient, KEY, postsList, {}, undefined);

            // A socket on its first connect attempt may still open and push.
            expect(client.expectsPush()).toBe(true);

            // The upgrade is refused: the socket closes without ever opening.
            sockets[0]?.drop();

            const result = registry.liveValue(queryClient, KEY, new AbortController().signal, { fetch: async () => client.query(postsList, {}) });

            await vi.advanceTimersByTimeAsync(100);

            expect(sockets).toHaveLength(1);
            // Well inside the push wait: only an immediate HTTP fallback has settled by now.
            await expect(Promise.race([result, Promise.resolve("still waiting")])).resolves.toBe("snapshot");

            detach();
        } finally {
            client.close();
        }
    });

    it("stops waiting for a push when the socket's first connect attempt fails mid-wait", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const sockets: MockSocket[] = [];
        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => Response.json({ result: "snapshot" })),
            persistence: false,
            pollingFallback: { intervalMs: 0 },
            queryCache: false,
            reconnect: { initialDelayMs: 60_000, jitter: false, maxDelayMs: 60_000 },
            url: "https://app.example",
            WebSocket: createMockWebSocket(sockets),
        });
        const registry = new LunoraSubscriptionRegistry(client);
        const queryClient = new QueryClient();
        const postsList = { __lunoraRef: "posts:list" };

        try {
            const detach = registry.attach(queryClient, KEY, postsList, {}, undefined);
            // A cold load: the wait starts while the socket is still on its first attempt.
            const result = registry.liveValue(queryClient, KEY, new AbortController().signal, { fetch: async () => client.query(postsList, {}) });

            await vi.advanceTimersByTimeAsync(10);
            sockets[0]?.drop();
            await vi.advanceTimersByTimeAsync(100);

            await expect(Promise.race([result, Promise.resolve("still waiting")])).resolves.toBe("snapshot");

            detach();
        } finally {
            client.close();
        }
    });
});
