import { describe, expect, it } from "vitest";

import type { SubscriptionState } from "../src/subscription";
import { SubscriptionRegistry } from "../src/subscription";

/** Minimal {@link SubscriptionState} carrying only the fields the registry keys on. */
const makeState = (id: string, fn: string, args: Record<string, unknown>, shardKey?: string): SubscriptionState =>
    ({ args, fn: { __lunoraRef: fn }, id, shardKey }) as unknown as SubscriptionState;

/**
 * `SubscriptionRegistry.key` routes `args` through the shared `stableStringify`
 * encoder (`shared/stable-key.ts`) so duplicate subscriptions collapse to one
 * server-side registration. These tests pin the now-shared semantics — key-order
 * stability and `undefined`-field skipping — so they can't silently drift from
 * the encoder's contract (mirrors `@lunora/do`'s reactive-cache assertions).
 */
describe("subscriptionRegistry.key", () => {
    it("is insensitive to arg property insertion order", () => {
        expect.assertions(1);

        const a = SubscriptionRegistry.key("messages:list", { channel: "general", limit: 10 });
        const b = SubscriptionRegistry.key("messages:list", { limit: 10, channel: "general" });

        expect(a).toBe(b);
    });

    it("is stable for nested objects regardless of order", () => {
        expect.assertions(1);

        const a = SubscriptionRegistry.key("q", { filter: { name: "alice", role: "admin" } });
        const b = SubscriptionRegistry.key("q", { filter: { role: "admin", name: "alice" } });

        expect(a).toBe(b);
    });

    it("treats an explicit `undefined` field the same as an absent one", () => {
        expect.assertions(1);

        const withUndefined = SubscriptionRegistry.key("q", { cursor: undefined, limit: 10 });
        const without = SubscriptionRegistry.key("q", { limit: 10 });

        expect(withUndefined).toBe(without);
    });

    it("discriminates by function path and shard key", () => {
        expect.assertions(2);

        const base = SubscriptionRegistry.key("q", { limit: 10 });

        expect(SubscriptionRegistry.key("other", { limit: 10 })).not.toBe(base);
        expect(SubscriptionRegistry.key("q", { limit: 10 }, "shard-1")).not.toBe(base);
    });
});

describe("subscriptionRegistry.remove", () => {
    it("removing an old state does not evict a newer state that re-claimed the same key", () => {
        expect.assertions(3);

        const registry = new SubscriptionRegistry();
        const s1 = makeState("sub_1", "q", { limit: 10 });
        const s2 = makeState("sub_2", "q", { limit: 10 });

        registry.add(s1);
        // A fresh subscription under the same (fn, args, shardKey) re-claims the
        // byKey slot (S1 already completed server-side); both live under byId.
        registry.add(s2);

        // A late unsubscribe of S1 must not delete S2's byKey slot.
        registry.remove(s1);

        expect(registry.get(SubscriptionRegistry.key("q", { limit: 10 }))).toBe(s2);
        expect(registry.getById("sub_2")).toBe(s2);
        expect(registry.getById("sub_1")).toBeUndefined();
    });

    it("removing the current state evicts its byKey slot", () => {
        expect.assertions(2);

        const registry = new SubscriptionRegistry();
        const state = makeState("sub_1", "q", { limit: 10 });

        registry.add(state);
        registry.remove(state);

        expect(registry.get(SubscriptionRegistry.key("q", { limit: 10 }))).toBeUndefined();
        expect(registry.getById("sub_1")).toBeUndefined();
    });
});
