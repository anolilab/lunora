import type { LunoraClient } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraSubscriptionRegistry } from "../src/cache";
import { keyHash } from "../src/query-key";

const KEY: QueryKey = ["lunora", "posts:list", {}, null];

/** A client with a socket implementation that never pushes: a blocked socket with the polling fallback off. */
const silentClient = {
    getWebSocketImpl: () => WebSocket,
    isCrossTabFollower: () => false,
} as unknown as LunoraClient;

describe("lunoraSubscriptionRegistry.liveValue", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("falls back to the HTTP fetch when nothing pushes within the wait bound", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const result = registry.liveValue(new QueryClient(), KEY, new AbortController().signal, async () => "snapshot");

        await vi.advanceTimersByTimeAsync(10_000);

        await expect(result).resolves.toBe("snapshot");
    });

    it("rejects at once for a signal that was already aborted", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const controller = new AbortController();

        controller.abort(new Error("unmounted"));

        await expect(registry.liveValue(new QueryClient(), KEY, controller.signal, async () => "snapshot")).rejects.toThrow("unmounted");
    });

    it("returns a null pushed while the HTTP fallback was in flight, not the snapshot", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);
        const queryClient = new QueryClient();
        const result = registry.liveValue(
            queryClient,
            KEY,
            new AbortController().signal,
            async () => {
                // A push lands while the fallback runs: the subscription now holds `null`.
                registry["liveFor"](keyHash(KEY)).pushed = true;
                queryClient.setQueryData(KEY, null);

                return "snapshot";
            },
            false,
        );

        await expect(result).resolves.toBeNull();
    });

    it("forgets the live state of a key nothing subscribes to once the HTTP fallback settles", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        await registry.liveValue(new QueryClient(), KEY, new AbortController().signal, async () => "snapshot", false);

        expect(registry["live"].size).toBe(0);
    });

    it("forgets the live state of a key nothing subscribes to when the HTTP fallback rejects", async () => {
        expect.assertions(2);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        await expect(
            registry.liveValue(
                new QueryClient(),
                KEY,
                new AbortController().signal,
                async () => {
                    throw new Error("offline");
                },
                false,
            ),
        ).rejects.toThrow("offline");

        expect(registry["live"].size).toBe(0);
    });

    it("keeps the live state of a key a subscription still feeds", async () => {
        expect.assertions(1);

        const registry = new LunoraSubscriptionRegistry(silentClient);

        registry["entries"].set(keyHash(KEY), {} as never);

        await registry.liveValue(new QueryClient(), KEY, new AbortController().signal, async () => "snapshot", false);

        expect(registry["live"].has(keyHash(KEY))).toBe(true);
    });
});
