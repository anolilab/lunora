import { describe, expect, it } from "vitest";

import { encodeWire, needsWireEncoding } from "../../../shared/wire-codec";

/**
 * `encodeDocJson` skips `encodeWire` when `needsWireEncoding` says the value is
 * already the JSON it would become. The predicate is therefore load-bearing in
 * one direction only: a false positive costs a wasted encode, a false negative
 * writes different bytes than the store expects — and the row store's OCC
 * compare-and-swap matches on those exact bytes, so the damage is a write that
 * silently stops matching its own row.
 *
 * These assert the one property that makes the fast path sound:
 *
 * `needsWireEncoding(v) === false` implies `JSON.stringify(encodeWire(v)) === JSON.stringify(v)`.
 *
 * The fuzz case is the important one. The table below documents intent; the
 * generator is what actually covers the combinations nobody thought to list.
 */

/** The property, checked directly. */
const isIdentity = (value: unknown): boolean => {
    let encoded: string;
    let plain: string;

    try {
        encoded = JSON.stringify(encodeWire(value));
        plain = JSON.stringify(value);
    } catch {
        // Either side throwing means this value is not on the fast path anyway.
        return false;
    }

    return encoded === plain;
};

describe("needsWireEncoding", () => {
    it.each([
        ["null", null],
        ["string", "hello"],
        ["boolean", true],
        ["integer", 42],
        ["float", 3.14],
        ["negative zero", -0],
        ["empty object", {}],
        ["empty array", []],
        ["flat document", { a: 1, b: "two", c: false }],
        ["nested plain", { user: { name: "x", tags: ["a", "b"] } }],
        ["null field", { a: null }],
        ["undefined object field (both drop it)", { a: 1, b: undefined }],
        ["array of primitives", [1, "a", true, null]],
    ])("treats %s as identity", (_label, value) => {
        expect.assertions(2);

        expect(needsWireEncoding(value)).toBe(false);
        expect(isIdentity(value)).toBe(true);
    });

    it.each([
        ["bigint", 1n],
        ["Date", new Date(0)],
        ["Map", new Map([["a", 1]])],
        ["Set", new Set([1])],
        ["URL", new URL("https://example.com")],
        ["ArrayBuffer", new ArrayBuffer(4)],
        ["Uint8Array", new Uint8Array(4)],
        ["Error", new Error("boom")],
        ["NaN", Number.NaN],
        ["Infinity", Number.POSITIVE_INFINITY],
        ["-Infinity", Number.NEGATIVE_INFINITY],
        ["undefined in an array position", [1, undefined, 3]],
        ["nested bigint", { a: { b: [{ c: 1n }] } }],
        ["nested Date", { at: { when: new Date(0) } }],
        [
            "class instance",
            new (class Thing {
                public marker = 1;
            })(),
        ],
    ])("routes %s to the encoder", (_label, value) => {
        expect.assertions(1);

        expect(needsWireEncoding(value)).toBe(true);
    });

    it("routes an array whose first element is the wire sentinel", () => {
        expect.assertions(2);

        // `encodeWire` wraps this as an `"arr"` payload so the decoder can tell it
        // from a real tagged value — the one case where an all-string array is
        // not identity.
        const sentinel = ["$lunora.wire$", "x"];

        expect(needsWireEncoding(sentinel)).toBe(true);
        expect(isIdentity(sentinel)).toBe(false);
    });

    it("routes a cyclic graph to the encoder rather than looping", () => {
        expect.assertions(1);

        const cyclic: Record<string, unknown> = { a: 1 };
        cyclic["self"] = cyclic;

        expect(needsWireEncoding(cyclic)).toBe(true);
    });

    it("never claims identity for a value that is not identity (fuzz)", () => {
        expect.hasAssertions();

        // A tiny deterministic LCG: reproducible, and no dependency.
        let seed = 0x2_f6_e2_b1;
        const next = (): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

            return seed / 2_147_483_648;
        };

        const leaf = (): unknown => {
            const pick = Math.floor(next() * 12);

            // Deliberately weighted toward the wire-typed leaves, so the generator
            // spends its time on the values that distinguish the two paths.
            return [null, "s", 7, -0, true, 1n, new Date(0), Number.NaN, undefined, new Map(), new Uint8Array(2), "$lunora.wire$"][pick];
        };

        const build = (depth: number): unknown => {
            if (depth <= 0 || next() < 0.35) {
                return leaf();
            }

            const size = 1 + Math.floor(next() * 3);

            if (next() < 0.5) {
                return Array.from({ length: size }, () => build(depth - 1));
            }

            return Object.fromEntries(Array.from({ length: size }, (_value, index) => [`k${String(index)}`, build(depth - 1)]));
        };

        const offenders: unknown[] = [];

        for (let index = 0; index < 4000; index += 1) {
            const value = build(4);

            if (!needsWireEncoding(value) && !isIdentity(value)) {
                offenders.push(value);
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});
