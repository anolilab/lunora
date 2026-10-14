import { describe, expect, it } from "vitest";

import { stableWireKey } from "../../../shared/wire-key";
import type { SubscriptionState } from "../src/subscription";
import { SubscriptionRegistry } from "../src/subscription";

/**
 * Minimal {@link SubscriptionState} carrying only the fields the registry keys
 * on. `argsKey` is what `subscribe()` caches at registration time, and what the
 * registry's key derivation reads — a double without it would key every state
 * identically.
 */
const makeState = (id: string, fn: string, args: Record<string, unknown>, shardKey?: string): SubscriptionState =>
    ({ args, argsKey: stableWireKey(args), fn: { __lunoraRef: fn }, id, shardKey }) as unknown as SubscriptionState;

/**
 * `SubscriptionRegistry.key` routes `args` through the shared `stableWireKey`
 * encoder (`shared/wire-key.ts`) so duplicate subscriptions collapse to one
 * server-side registration — byte-identical to the old `stableStringify` keys
 * for pure-JSON args, distinct stable tokens for wire-typed args. These tests
 * pin the now-shared semantics — key-order stability, `undefined`-field
 * skipping, and wire-typed distinctness — so they can't silently drift from
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

    it("keeps the exact key format for pure-JSON args (no cache/dedup invalidation)", () => {
        expect.assertions(1);

        // The registry moved from `stableStringify` to `stableWireKey`, which is
        // byte-identical for pure JSON — pinned literally so a drift is loud.
        expect(SubscriptionRegistry.key("messages:list", { channel: "general", limit: 10 }, "s1")).toBe('messages:list::{"channel":"general","limit":10}::s1');
    });

    it("keys wire-typed args (bigint / Date / bytes) without throwing, distinct per value", () => {
        expect.assertions(4);

        expect(() => SubscriptionRegistry.key("q", { since: 123n })).not.toThrow();
        expect(SubscriptionRegistry.key("q", { since: 123n })).not.toBe(SubscriptionRegistry.key("q", { since: 124n }));
        expect(SubscriptionRegistry.key("q", { at: new Date(1000) })).not.toBe(SubscriptionRegistry.key("q", { at: new Date(2000) }));
        expect(SubscriptionRegistry.key("q", { blob: new Uint8Array([1]).buffer })).not.toBe(
            SubscriptionRegistry.key("q", { blob: new Uint8Array([2]).buffer }),
        );
    });

    it("still fails loud on args the wire refuses (RegExp)", () => {
        expect.assertions(1);

        expect(() => SubscriptionRegistry.key("q", { pattern: /abc/ })).toThrow(TypeError);
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

    it("removes a state whose caller mutated its args object after registering", () => {
        expect.assertions(2);

        const registry = new SubscriptionRegistry();
        const args: Record<string, unknown> = { limit: 10 };
        const state = makeState("sub_1", "q", args);

        registry.add(state);

        // `args` is the caller's own object, retained by reference. Re-deriving
        // the key from it on remove would compute a DIFFERENT key here and leak
        // the registration forever (and, for a RegExp, throw).
        args.limit = 20;
        args.pattern = /abc/;

        expect(() => {
            registry.remove(state);
        }).not.toThrow();
        expect(registry.get(SubscriptionRegistry.key("q", { limit: 10 }))).toBeUndefined();
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
