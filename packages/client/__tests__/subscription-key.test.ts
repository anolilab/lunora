import { describe, expect, it } from "vitest";

import { SubscriptionRegistry } from "../src/subscription";

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
