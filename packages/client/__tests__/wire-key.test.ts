import { describe, expect, it } from "vitest";

import { stableStringify } from "../../../shared/stable-key";
import { stableWireKey } from "../../../shared/wire-key";

/**
 * The wire-faithful cache-key encoder (`shared/wire-key.ts`) — the composition
 * `stableStringify(encodeWire(value))` every reactive cache key (subscription
 * registry, `useQuery` memo keys, DO reactive cache, shape routing) rides on.
 * Two load-bearing properties are pinned here: identity for pure JSON
 * (byte-identical to `stableStringify`, so the key-namespace migration
 * invalidated no existing cache entry), and distinct stable tokens for
 * wire-typed leaves (`bigint`/`Date`/bytes/`Map`/`Set`/`URL` args key
 * deterministically instead of throwing, and two values that differ only in
 * such a leaf can never collide).
 */
describe("stableWireKey", () => {
    it("is byte-identical to stableStringify for pure-JSON values (no cache invalidation)", () => {
        expect.assertions(4);

        const values: unknown[] = [{ a: 1, b: [2, 3], c: "x", d: null }, { nested: { deep: { list: [1, "two", false, null] } } }, [], {}];

        for (const value of values) {
            expect(stableWireKey(value)).toBe(stableStringify(value));
        }
    });

    it("normalizes key order and skips undefined fields exactly like stableStringify", () => {
        expect.assertions(2);

        expect(stableWireKey({ b: 2, a: 1 })).toBe(stableWireKey({ a: 1, b: 2 }));
        expect(stableWireKey({ a: 1, cursor: undefined })).toBe(stableWireKey({ a: 1 }));
    });

    it("keys bigint args without throwing, distinct per value", () => {
        expect.assertions(3);

        expect(() => stableStringify({ since: 123n })).toThrow(TypeError);
        expect(() => stableWireKey({ since: 123n })).not.toThrow();
        expect(stableWireKey({ since: 123n })).not.toBe(stableWireKey({ since: 124n }));
    });

    it("keys Date args distinct per timestamp and distinct from the raw epoch number", () => {
        expect.assertions(2);

        const a = stableWireKey({ at: new Date(1000) });
        const b = stableWireKey({ at: new Date(2000) });

        expect(a).not.toBe(b);
        // A Date and its epoch-ms number are different arg values — never one key.
        expect(a).not.toBe(stableWireKey({ at: 1000 }));
    });

    it("keys bytes (ArrayBuffer / typed arrays) by content", () => {
        expect.assertions(2);

        const bytes = (values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

        expect(stableWireKey({ blob: bytes([1, 2]) })).toBe(stableWireKey({ blob: bytes([1, 2]) }));
        expect(stableWireKey({ blob: bytes([1, 2]) })).not.toBe(stableWireKey({ blob: bytes([1, 3]) }));
    });

    it("keys Map/Set/URL deterministically", () => {
        expect.assertions(3);

        expect(stableWireKey({ m: new Map([["a", 1n]]) })).toBe(stableWireKey({ m: new Map([["a", 1n]]) }));
        expect(stableWireKey({ s: new Set([1, 2]) })).not.toBe(stableWireKey({ s: new Set([1, 3]) }));
        expect(stableWireKey({ u: new URL("https://a.example/x") })).not.toBe(stableWireKey({ u: new URL("https://a.example/y") }));
    });

    it("keys Map/Set by INSERTION ORDER (the documented caveat)", () => {
        expect.assertions(1);

        // Two structurally-equal Maps built in different orders key differently —
        // they open separate subscriptions (wasteful, never wrong). Pinned so a
        // future "sort entries" change is a conscious key-namespace migration.
        // Built via `.set()` so no literal-sorting autofix can equalize the orders.
        const forward = new Map<string, number>().set("a", 1).set("b", 2);
        const reversed = new Map<string, number>().set("b", 2).set("a", 1);

        expect(stableWireKey(forward)).not.toBe(stableWireKey(reversed));
    });

    it("distinguishes NaN / +Infinity / -Infinity instead of collapsing all to null", () => {
        expect.assertions(3);

        expect(stableWireKey({ n: Number.NaN })).not.toBe(stableWireKey({ n: Infinity }));
        expect(stableWireKey({ n: Infinity })).not.toBe(stableWireKey({ n: -Infinity }));
        expect(stableWireKey({ n: Number.NaN })).not.toBe(stableWireKey({ n: null }));
    });

    it("still fails loud on values the wire refuses (RegExp, class instances)", () => {
        expect.assertions(2);

        class Thing {
            public readonly kind = "thing";
        }

        expect(() => stableWireKey({ pattern: /abc/ })).toThrow(TypeError);
        expect(() => stableWireKey({ thing: new Thing() })).toThrow(TypeError);
    });

    it("cannot collide a tagged leaf with a user array that mimics the sentinel", () => {
        expect.assertions(1);

        // `encodeWire` escapes a literal `["$lunora.wire$", ...]` user array via
        // its `"arr"` wrapper, so it can never share a key with a real bigint tag.
        expect(stableWireKey({ v: ["$lunora.wire$", "bigint", "123"] })).not.toBe(stableWireKey({ v: 123n }));
    });
});
