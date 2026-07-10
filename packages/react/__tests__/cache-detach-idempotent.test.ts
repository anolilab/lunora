import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { LunoraSubscriptionRegistry } from "../src/cache";

const FN: FunctionReference = { __lunoraRef: "posts:list" };
const KEY: QueryKey = ["lunora", "posts:list", {}, null];

/** A client whose `subscribe` hands back a distinct unsubscribe spy per call so a test can prove which subscription a detach closes. */
const buildClient = (): { client: LunoraClient; subscribe: ReturnType<typeof vi.fn>; unsubscribes: ReturnType<typeof vi.fn>[] } => {
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    const subscribe = vi.fn<() => Unsubscribe>(() => {
        const unsubscribe = vi.fn<() => void>();

        unsubscribes.push(unsubscribe);

        return unsubscribe;
    });

    const client = { subscribe } as unknown as LunoraClient;

    return { client, subscribe, unsubscribes };
};

describe("lunoraSubscriptionRegistry detach idempotency", () => {
    it("a second call of the same detach is a no-op and never closes a re-attached consumer's subscription", () => {
        expect.assertions(5);

        const { client, subscribe, unsubscribes } = buildClient();
        const registry = new LunoraSubscriptionRegistry(client);
        // Only the subscribe callback / poll fallback touch the QueryClient, and
        // neither runs here — a bare stub is enough.
        const queryClient = {} as QueryClient;

        // Consumer A attaches, then fully detaches (entry deleted, sub A closed).
        const detachA = registry.attach(queryClient, KEY, FN, {}, undefined);

        detachA();

        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(unsubscribes[0]).toHaveBeenCalledTimes(1);

        // Consumer B attaches the SAME key — a fresh entry + a second live sub.
        const detachB = registry.attach(queryClient, KEY, FN, {}, undefined);

        expect(subscribe).toHaveBeenCalledTimes(2);

        // A stale second call of A's detach must not find B's entry and tear it
        // down: B is still mounted and must keep receiving pushes.
        detachA();

        expect(unsubscribes[1]).not.toHaveBeenCalled();

        // B's own detach still closes exactly its own subscription.
        detachB();

        expect(unsubscribes[1]).toHaveBeenCalledTimes(1);
    });
});
