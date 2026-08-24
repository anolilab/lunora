import { describe, expect, it } from "vitest";

import { contentDigest } from "../../../shared/content-digest";
import { stableStringify } from "../../../shared/stable-key";

/**
 * The shared change-detection digest (`shared/content-digest.ts`).
 *
 * Two consumers depend on it and neither tolerates instability: the schema
 * version ledger treats a repeated digest as "already recorded" and keeps the
 * OLDER snapshot, and an `onQueryChange` reactor treats a repeated digest as
 * "nothing changed" and skips its handler. So the properties under test are the
 * two that matter — **determinism** (the same input always digests the same, or
 * a reactor fires on every flush forever) and **discrimination** (different
 * inputs digest differently, or a reactor silently stops firing).
 *
 * Collisions are possible at ~64 bits and are an accepted cost, documented at the
 * source: content addressing here is for identity and dedup, never security.
 * These tests pin the shape and the obvious near-miss cases, not the absence of
 * collisions, which no test could establish.
 */
describe("contentDigest", () => {
    it("returns a stable 16-character lowercase hex string", () => {
        expect.assertions(2);

        const digest = contentDigest("hello");

        expect(digest).toHaveLength(16);
        expect(digest).toMatch(/^[\da-f]{16}$/u);
    });

    it("is deterministic across calls", () => {
        expect.assertions(1);

        // The load-bearing property for a reactor baseline: an unchanged result
        // must digest identically on the next flush, or the handler runs forever.
        expect(contentDigest("the same input")).toBe(contentDigest("the same input"));
    });

    it("separates inputs that differ by a single character", () => {
        expect.assertions(2);

        expect(contentDigest("a")).not.toBe(contentDigest("b"));
        expect(contentDigest("order-1")).not.toBe(contentDigest("order-2"));
    });

    it("separates a transposition, which a weak checksum would collide", () => {
        expect.assertions(1);

        expect(contentDigest("ab")).not.toBe(contentDigest("ba"));
    });

    it("separates the empty string from a blank one", () => {
        expect.assertions(2);

        expect(contentDigest("")).toHaveLength(16);
        expect(contentDigest("")).not.toBe(contentDigest(" "));
    });

    it("handles non-ASCII without collapsing distinct code points", () => {
        expect.assertions(2);

        expect(contentDigest("café")).not.toBe(contentDigest("cafe"));
        expect(contentDigest("日本")).not.toBe(contentDigest("本日"));
    });

    it("composes with stableStringify so key order does not change the digest", () => {
        expect.assertions(2);

        // How a reactor actually digests its result. If key order leaked through,
        // a refactor that reordered a select's projection would re-fire every
        // reactor watching it.
        const a = contentDigest(stableStringify({ desk: "x", status: "waiting" }));
        const b = contentDigest(stableStringify({ status: "waiting", desk: "x" }));

        expect(a).toBe(b);
        expect(a).not.toBe(contentDigest(stableStringify({ desk: "y", status: "waiting" })));
    });

    it("distinguishes an empty result from a one-element one", () => {
        expect.assertions(1);

        // The first-run case: a reactor with no baseline digests `[]` and must not
        // match the digest of an actual row arriving.
        expect(contentDigest(stableStringify([]))).not.toBe(contentDigest(stableStringify([{ id: "a" }])));
    });
});
