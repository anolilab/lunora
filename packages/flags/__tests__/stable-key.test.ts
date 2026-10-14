import { describe, expect, it } from "vitest";

import { stableStringify } from "../../../shared/stable-key";

/**
 * Plan 355 regression: `stableStringify` used to collapse `undefined`, `null`,
 * `NaN`, `Infinity`, and `-Infinity` all into the same `"null"` string (`JSON
 * .stringify` maps every non-finite number to `null`). That silently colluded
 * distinct cache keys — see `packages/flags/src/flags.ts`'s memo key and
 * `packages/observability/src/metric-buffer.ts`'s series key, both of which key
 * caches on this encoder. This file guards the fix at the encoder level; the two
 * call sites have their own regression tests (`flags.test.ts`,
 * `metric-buffer.test.ts` in `@lunora/observability`).
 */
describe("stableStringify non-finite number tagging", () => {
    it("encodes NaN, Infinity, -Infinity, and null as four distinct strings", () => {
        expect.assertions(1);

        const encodings = [Number.NaN, Infinity, -Infinity, null].map((value) => stableStringify(value));

        expect(new Set(encodings).size).toBe(4);
    });

    it("still encodes pure-JSON values byte-identically (the stableWireKey byte-identity guard)", () => {
        expect.assertions(8);

        expect(stableStringify(null)).toBe("null");
        expect(stableStringify(true)).toBe("true");
        expect(stableStringify(false)).toBe("false");
        expect(stableStringify(0)).toBe("0");
        expect(stableStringify(42)).toBe("42");
        expect(stableStringify(-1.5)).toBe("-1.5");
        expect(stableStringify("hi")).toBe('"hi"');
        expect(stableStringify({ a: 1, b: [2, 3], c: "x", d: null })).toBe('{"a":1,"b":[2,3],"c":"x","d":null}');
    });

    it("keeps undefined inside an array encoding as null (positional semantics, unchanged)", () => {
        expect.assertions(1);

        expect(stableStringify([1, undefined, 3])).toBe("[1,null,3]");
    });

    it("still throws a clear error on a bigint (unchanged)", () => {
        expect.assertions(1);

        expect(() => stableStringify(1n)).toThrow(/bigint/);
    });

    it("tags -0 distinctly from 0", () => {
        expect.assertions(2);

        expect(stableStringify(0)).toBe("0");
        expect(stableStringify(-0)).not.toBe(stableStringify(0));
    });
});
