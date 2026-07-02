import { describe, expect, it } from "vitest";

import { stableStringify } from "../../../shared/stable-key";

/**
 * The shared cache-key encoder's fail-loud contract (`shared/stable-key.ts`).
 * Types a stable JSON key can't faithfully encode must throw a clear error rather
 * than silently collide — `Date`/`ArrayBuffer`/`Map`/`Set`/`RegExp` all have no own
 * enumerable keys and would otherwise encode to `{}`, so two distinct values would
 * share a key and be served each other's cached data. Pure-JSON keys are unchanged.
 */
describe("stableStringify fail-loud contract", () => {
    it("still encodes plain JSON exactly as before (no behavior drift)", () => {
        expect.assertions(2);

        expect(stableStringify({ a: 1, b: [2, 3], c: "x", d: null })).toBe('{"a":1,"b":[2,3],"c":"x","d":null}');
        // Key order is normalized; `undefined` fields are skipped.
        expect(stableStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
    });

    it("throws a clear error on a bigint instead of JSON.stringify's cryptic one", () => {
        expect.assertions(2);

        expect(() => stableStringify(1n)).toThrow(TypeError);
        expect(() => stableStringify({ id: 42n })).toThrow(/bigint/);
    });

    it("throws instead of silently colliding Date / ArrayBuffer / typed arrays to {}", () => {
        expect.assertions(4);

        // Two DIFFERENT values that would each collapse to `{}` under the old
        // record branch — the exact silent cache-key collision this guards.
        expect(() => stableStringify(new Date("2026-07-02"))).toThrow(/Date/);
        expect(() => stableStringify({ at: new Date("2026-07-02") })).toThrow(TypeError);
        expect(() => stableStringify(new Uint8Array([1, 2, 3]))).toThrow(TypeError);
        expect(() => stableStringify({ blob: new ArrayBuffer(8) })).toThrow(TypeError);
    });

    it("throws on Map / Set / RegExp", () => {
        expect.assertions(3);

        expect(() => stableStringify(new Map([["a", 1]]))).toThrow(/Map/);
        expect(() => stableStringify(new Set([1, 2]))).toThrow(/Set/);
        expect(() => stableStringify({ re: /ab+c/g })).toThrow(/RegExp/);
    });

    it("still accepts a null-prototype object as a plain record", () => {
        expect.assertions(1);

        const record = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1, b: 2 });

        expect(stableStringify(record)).toBe('{"a":1,"b":2}');
    });
});
