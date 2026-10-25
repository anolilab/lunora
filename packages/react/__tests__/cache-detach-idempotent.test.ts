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

describe("lunoraSubscriptionRegistry attach failures", () => {
    it("rethrows a subscribe failure and leaves no half-registered entry behind", () => {
        expect.assertions(3);

        const subscribe = vi.fn<() => Unsubscribe>(() => {
            throw new Error("client is closed");
        });
        const registry = new LunoraSubscriptionRegistry({ subscribe } as unknown as LunoraClient);
        const queryClient = {} as QueryClient;

        // A closed client (or unencodable args) is a programming error. Swallowing
        // it behind a 5s `invalidateQueries` loop only hid the stack.
        expect(() => registry.attach(queryClient, KEY, FN, {}, undefined)).toThrow("client is closed");

        // The failed attach registered nothing, so the next one really retries.
        expect(() => registry.attach(queryClient, KEY, FN, {}, undefined)).toThrow("client is closed");
        expect(subscribe).toHaveBeenCalledTimes(2);
    });
});

describe("lunoraSubscriptionRegistry detach idempotency", () => {
    it("a second call of the same detach is a no-op and never closes a re-attached consumer's subscription", () => {
        expect.assertions(5);

        const { client, subscribe, unsubscribes } = buildClient();
        const registry = new LunoraSubscriptionRegistry(client);
        // Only the subscribe callback touches the QueryClient, and it never runs
        // here — a bare stub is enough.
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
