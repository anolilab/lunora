import { afterEach, describe, expect, it } from "vitest";

import { copycat, hashInput, setHashKey } from "../src/copycat";

describe("copycat determinism", () => {
    afterEach(() => {
        // Reset the module-level salt so a setHashKey test can't leak into others.
        setHashKey(0);
    });

    it("maps the same input to the same output every time", () => {
        expect.hasAssertions();

        expect(copycat.email("alice")).toBe(copycat.email("alice"));
        expect(copycat.fullName(42)).toBe(copycat.fullName(42));
        expect(copycat.uuid({ a: 1 })).toBe(copycat.uuid({ a: 1 }));
    });

    it("is independent of call order — an interleaved call does not shift the result", () => {
        expect.hasAssertions();

        const first = copycat.email("alice");

        // Make unrelated calls that re-seed faker, then re-request the same input.
        copycat.email("bob");
        copycat.int("charlie");
        copycat.fullName("dave");

        expect(copycat.email("alice")).toBe(first);
    });

    it("treats objects as equal regardless of key order", () => {
        expect.hasAssertions();

        expect(copycat.email({ a: 1, b: 2 })).toBe(copycat.email({ b: 2, a: 1 }));
        expect(hashInput({ x: 1, y: 2 })).toBe(hashInput({ y: 2, x: 1 }));
    });

    it("produces different outputs for different inputs", () => {
        expect.hasAssertions();

        const a = copycat.fullName("input-one");
        const b = copycat.fullName("input-two");

        expect(a).not.toBe(b);
    });

    it("honours int/float ranges", () => {
        expect.hasAssertions();

        for (let index = 0; index < 50; index += 1) {
            const n = copycat.int(`row-${String(index)}`, { max: 10, min: 5 });

            expect(n).toBeGreaterThanOrEqual(5);
            expect(n).toBeLessThanOrEqual(10);
        }

        const f = copycat.float("f", { fractionDigits: 2, max: 1, min: 0 });

        expect(f).toBeGreaterThanOrEqual(0);
        expect(f).toBeLessThanOrEqual(1);
    });

    it("picks a stable element from oneOf and the whole set is reachable", () => {
        expect.hasAssertions();

        const values = ["red", "green", "blue"] as const;

        expect(copycat.oneOf("pick", values)).toBe(copycat.oneOf("pick", values));

        const seen = new Set<string>();

        for (let index = 0; index < 50; index += 1) {
            const picked = copycat.oneOf(`k-${String(index)}`, values);

            if (picked !== undefined) {
                seen.add(picked);
            }
        }

        expect(seen).toEqual(new Set(values));
        expect(copycat.oneOf<string>("x", [])).toBeUndefined();
    });

    it("generates a deterministic count and elements with times()", () => {
        expect.hasAssertions();

        const a = copycat.times("posts", [2, 5], (itemInput) => copycat.word(itemInput));
        const b = copycat.times("posts", [2, 5], (itemInput) => copycat.word(itemInput));

        expect(a).toEqual(b);
        expect(a.length).toBeGreaterThanOrEqual(2);
        expect(a.length).toBeLessThanOrEqual(5);
        // Distinct sub-inputs ⇒ the elements are not all identical.
        expect(new Set(a).size).toBeGreaterThan(1);
    });

    it("scramble preserves length and character classes", () => {
        expect.hasAssertions();

        const out = copycat.scramble("Ab3-Cd9");

        expect(out).toHaveLength(7);
        expect(out[3]).toBe("-");
        expect(/^[A-Z][a-z]\d-[A-Z][a-z]\d$/.test(out)).toBe(true);
        expect(copycat.scramble("Ab3-Cd9")).toBe(out);
    });

    it("preserves listed characters in scramble", () => {
        expect.hasAssertions();

        const out = copycat.scramble("a@b.com", { preserve: ["@", ".", "c", "o", "m"] });

        expect(out.endsWith("@b.com") || out.includes("@")).toBe(true);
        expect(out).toContain("@");
    });

    it("pins the cross-version stable mapping (regression: hash/seed logic must not silently drift)", () => {
        // These are the byte-exact outputs of the default (salt 0) mapping. The
        // package contract is that the same input yields the same value forever, so
        // a change here means previously-seeded fixtures would regenerate
        // differently — only update these constants for a deliberate, documented
        // mapping change.
        //
        // REBASELINE 2026-06-21 (intentional, one-time, alpha): `hashInput` now
        // tags raw-string inputs with a domain sentinel so a string can no longer
        // collide with the serialized form of a non-string (see the collision
        // regression test below and STRING_DOMAIN_TAG in src/copycat/hash.ts).
        // This shifted the values for *string-seeded* inputs only — the
        // non-string (array/object/number/...) path is unchanged, which is why
        // the two `[0, "users", 0, "_id"]` pins below kept their original values.
        // The values below are the new forever-contract baseline.
        expect.hasAssertions();

        expect(hashInput("alice")).toBe(2_519_185_623);
        expect(hashInput([0, "users", 0, "_id"])).toBe(3_789_945_327);
        // Regenerated when the generator moved to the RFC 2606 reserved domain:
        // passing faker an explicit `provider` also shifts its internal draw, so
        // the local part changed with it. Deterministic as before — just no longer
        // a real mailbox.
        expect(copycat.email("alice")).toBe("eusebio18@example.com");
        expect(copycat.uuid([0, "users", 0, "_id"])).toBe("156d21c5-998b-4e72-9653-ec28b5592873");
    });

    it("never generates a deliverable third-party address", () => {
        expect.hasAssertions();

        // Seeded rows land in real databases — a staging environment, or a `lunora
        // seed --prod`. Any user-driven mail flow (a welcome job, a digest, an auth
        // verification on a seeded account) then sends real mail, from the app's own
        // verified domain, to whoever actually owns those Gmail/Yahoo/Hotmail
        // addresses. RFC 2606 reserves `example.com` precisely so generated data
        // cannot do that.
        for (const input of ["alice", "bob", 42, ["users", 3, "email"], { id: 7 }]) {
            expect(copycat.email(input)).toMatch(/@example\.com$/u);
        }
    });

    it("isolates the raw-string domain from the serialized non-string domain (collision regression)", () => {
        // Before the 2026-06-21 fix, `hashInput` hashed strings raw but ran
        // non-strings through `stableStringify` first, so a string whose text
        // equalled a non-string's serialized form collided (same hash ⇒ same
        // generated value for semantically different inputs). The domain sentinel
        // must keep these pairs disjoint forever.
        expect.hasAssertions();

        expect(hashInput("[1,2]")).not.toBe(hashInput([1, 2]));
        expect(hashInput("true")).not.toBe(hashInput(true));
        expect(hashInput("null")).not.toBe(hashInput(null));
        expect(hashInput("42")).not.toBe(hashInput(42));
        expect(hashInput('{"a":1}')).not.toBe(hashInput({ a: 1 }));

        // The disambiguation also flows through to generated values.
        expect(copycat.email("[1,2]")).not.toBe(copycat.email([1, 2]));
    });

    it("setHashKey shifts the mapping deterministically and reset restores it", () => {
        expect.hasAssertions();

        const base = copycat.email("alice");

        setHashKey("a-long-enough-secret-value");
        const shifted = copycat.email("alice");

        expect(shifted).not.toBe(base);
        // Still deterministic under the new key.
        expect(copycat.email("alice")).toBe(shifted);

        setHashKey(0);

        expect(copycat.email("alice")).toBe(base);
    });
});
