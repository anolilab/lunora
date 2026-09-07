import { describe, expect, it } from "vitest";

import { applyDiff, applyDiffs, applyDiffToSnapshot, deriveInsertId, fnv1a64Hex } from "../src/apply-diff";
import type { RowChange, TableDiff } from "../src/table-diff";

const diffOf = (changes: RowChange[], id = "diff-1"): TableDiff => {
    return { changes, id, table: "users", timestamp: 1_700_000_000_000 };
};

/**
 * Reference implementation of the derived-id hash: the straightforward 64-bit
 * FNV-1a over `BigInt`. `deriveInsertId` computes the same digest with four
 * 16-bit limbs in plain numbers for speed; these tests pin the two together so
 * a future edit to the limb arithmetic cannot silently change derived row ids
 * (which would fork every replica that replays an older diff).
 */
const referenceFnv1a64 = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication; the bit ops ARE the algorithm */
    let hash = 0xcb_f2_9c_e4_84_22_23_25n;

    const prime = 0x00_00_01_00_00_00_01_b3n;
    const mask64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

    for (let index = 0; index < input.length; index += 1) {
        // UTF-16 code UNITS. `codePointAt` per INDEX folds an astral character
        // twice (its code point, then its trailing low surrogate) — a hybrid walk
        // no other FNV-1a produces, and the one the 32-bit digest was already
        // fixed for. See `shared/fnv1a.ts`.
        // eslint-disable-next-line unicorn/prefer-code-point -- see above
        hash ^= BigInt(input.charCodeAt(index));
        hash = (hash * prime) & mask64;
    }

    return hash.toString(16).padStart(16, "0");
    /* eslint-enable no-bitwise */
};

/**
 * Recreate the hash input `deriveInsertId` builds, the obvious way: sort every
 * object's keys by code unit and hand the copy to `JSON.stringify`.
 *
 * The shipped encoder is `stableWireKey`, which must agree with this byte for
 * byte on PURE-JSON rows — that identity is what keeps ids stable for the rows
 * that carry no wire-typed value, and it is the reason this reference is worth
 * keeping rather than re-deriving through the code under test. Rows holding a
 * `bigint`/`Date`/`Map`/bytes are covered in `apply-diff-canonical.test.ts`,
 * where this reference does NOT apply.
 */
const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};

        for (const key of Object.keys(record).sort()) {
            result[key] = canonicalize(record[key]);
        }

        return result;
    }

    return value;
};

const expectedDerivedId = (diff: TableDiff, data: Record<string, unknown>): string =>
    `row-${referenceFnv1a64(`${diff.table}::${JSON.stringify(canonicalize(data))}`)}`;

/**
 * The derived-id keys of an applyDiff result, in insertion order.
 *
 * Deliberately assertion-free: a helper that asserts on its caller's behalf
 * bakes a `+1` into every `expect.assertions(n)` that calls it, so changing one
 * line here fails five unrelated tests pointing at the wrong file. Callers
 * assert the whole array, which checks the count and the values in one go.
 */
const derivedKeys = (rows: Map<string, Record<string, unknown>>): string[] => [...rows.keys()].filter((key) => key.startsWith("row-"));

describe("applyDiff", () => {
    it("leaves the caller's map untouched", () => {
        expect.assertions(2);

        const current = new Map([["a", { id: "a", n: 1 }]]);

        const next = applyDiff(current, diffOf([{ id: "a", type: "delete" }]));

        expect(current.has("a")).toBe(true);
        expect(next.has("a")).toBe(false);
    });

    it("merges updates onto the existing row and skips unknown rows", () => {
        expect.assertions(2);

        const current = new Map([["a", { id: "a", name: "alice", n: 1 }]]);

        const next = applyDiff(
            current,
            diffOf([
                { data: { n: 2 }, id: "a", type: "update" },
                { data: { n: 3 }, id: "ghost", type: "update" },
            ]),
        );

        expect(next.get("a")).toStrictEqual({ id: "a", name: "alice", n: 2 });
        expect(next.has("ghost")).toBe(false);
    });

    it("keys an insert by its own id, coercing a numeric id to a string", () => {
        expect.assertions(1);

        const next = applyDiff(new Map(), diffOf([{ data: { id: 42, name: "n" }, type: "insert" }]));

        expect(next.get("42")).toStrictEqual({ id: "42", name: "n" });
    });
});

describe("fnv1a64Hex", () => {
    it("is bit-identical to the BigInt reference across 2000 random strings", () => {
        expect.assertions(1);

        // Driven directly against the exported function rather than through
        // `applyDiff`, so a divergence is attributed to the hash itself.
        let seed = 987_654;
        const next = (): number => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;

            return seed;
        };

        const mismatches: string[] = [];

        for (let index = 0; index < 2000; index += 1) {
            let input = "";

            for (let position = 0; position < index % 64; position += 1) {
                // Mix ASCII, BMP and astral code points.
                const roll = next() % 3;

                if (roll === 0) {
                    input += String.fromCodePoint(32 + (next() % 90));
                } else if (roll === 1) {
                    input += String.fromCodePoint(0x01_00 + (next() % 0x0f_00));
                } else {
                    input += "🎉";
                }
            }

            if (fnv1a64Hex(input) !== referenceFnv1a64(input)) {
                mismatches.push(input);
            }
        }

        expect(mismatches).toStrictEqual([]);
    });

    it("folds an astral character ONCE, like the 32-bit digest", () => {
        expect.assertions(2);

        // The walk was `codePointAt` per INDEX, so a surrogate pair contributed
        // twice: its whole code point at the first index and its trailing low
        // surrogate at the second. Neither a code-unit nor a code-point walk, and
        // no other FNV-1a agrees with it. Folding the two units of the pair is the
        // same work as folding the two-character string they spell.
        const pair = "\uD83D\uDE00";

        expect(fnv1a64Hex(pair)).toBe(referenceFnv1a64(pair));
        expect(fnv1a64Hex(pair)).not.toBe(fnv1a64Hex(`${pair}\uDE00`));
    });

    it("matches the reference on boundary inputs", () => {
        expect.hasAssertions();

        for (const input of ["", "a", "\0", "\u{10FFFF}", "\uD800", "\uDFFF", "é中文", "x".repeat(1000)]) {
            expect(fnv1a64Hex(input), `mismatch for ${JSON.stringify(input)}`).toBe(referenceFnv1a64(input));
        }
    });
});

describe("the content encoding behind a derived id", () => {
    it("orders keys by code unit, not by locale collation", () => {
        expect.assertions(4);

        // The pins that matter are the pairs a `localeCompare` comparator would
        // order the other way round — a locale-dependent order derives DIFFERENT
        // ids for the SAME row on two clients (REPLICA-05). Asserting against a
        // key-sorted `JSON.stringify` also pins the byte-for-byte agreement with
        // the reference on pure-JSON rows.
        for (const data of [
            { B: 1, a: 2 },
            { a: 2, B: 1 },
            { "a-b": 1, aXb: 3, a_b: 2 },
            { o: { z: 1, a: { y: 1, b: 2 } }, list: [3, 1, 2] },
        ]) {
            const diff = diffOf([{ data, type: "insert" }]);

            expect(deriveInsertId(diff, data), `mismatch for ${JSON.stringify(data)}`).toBe(expectedDerivedId(diff, data));
        }
    });

    it("is insensitive to insertion order at every depth", () => {
        expect.assertions(2);

        const diff = diffOf([]);

        expect(deriveInsertId(diff, { B: 1, a: 2 })).toBe(deriveInsertId(diff, { a: 2, B: 1 }));
        expect(deriveInsertId(diff, { o: { z: 1, a: 2 }, list: [3, 1] })).toBe(deriveInsertId(diff, { list: [3, 1], o: { a: 2, z: 1 } }));
    });
});

describe("deriveInsertId (via id-less inserts)", () => {
    it("is exported and agrees with what applyDiff derives", () => {
        expect.assertions(1);

        const data = { name: "alice" };
        const diff = diffOf([{ data, type: "insert" }]);

        expect(derivedKeys(applyDiff(new Map(), diff))).toStrictEqual([deriveInsertId(diff, data)]);
    });

    it("matches the BigInt FNV-1a reference digest", () => {
        expect.assertions(1);

        const data = { body: "hello world", tags: ["a", "b"] };
        const diff = diffOf([{ data, type: "insert" }]);

        const next = applyDiff(new Map(), diff);

        expect(derivedKeys(next)).toStrictEqual([expectedDerivedId(diff, data)]);
    });

    it("matches the reference digest for astral code points", () => {
        expect.assertions(1);

        const data = { note: "🎉 party \u{10FFFF}", who: "é中文" };
        const diff = diffOf([{ data, type: "insert" }]);

        const next = applyDiff(new Map(), diff);

        expect(derivedKeys(next)).toStrictEqual([expectedDerivedId(diff, data)]);
    });

    it("derives the same id when the same diff is replayed", () => {
        expect.assertions(1);

        const diff = diffOf([{ data: { name: "alice" }, type: "insert" }]);

        expect([...applyDiff(new Map(), diff).keys()]).toStrictEqual([...applyDiff(new Map(), diff).keys()]);
    });

    it("is insensitive to key insertion order at any depth", () => {
        expect.assertions(2);

        const shallow = applyDiff(new Map(), diffOf([{ data: { a: 1, b: 2 }, type: "insert" }]));
        const shallowReordered = applyDiff(new Map(), diffOf([{ data: { b: 2, a: 1 }, type: "insert" }]));

        expect([...shallow.keys()]).toStrictEqual([...shallowReordered.keys()]);

        const nested = applyDiff(new Map(), diffOf([{ data: { outer: { x: 1, y: { p: 1, q: 2 } } }, type: "insert" }]));
        const nestedReordered = applyDiff(new Map(), diffOf([{ data: { outer: { y: { q: 2, p: 1 }, x: 1 } }, type: "insert" }]));

        expect([...nested.keys()]).toStrictEqual([...nestedReordered.keys()]);
    });

    it("sorts keys by code unit, not by locale collation", () => {
        expect.assertions(1);

        // "B" (0x42) sorts before "a" (0x61) by code unit, but AFTER it under
        // ICU collation — so this pair is exactly where a localeCompare-based
        // canonicalizer would disagree with the reference, and where two
        // clients in different locales would previously derive different ids.
        const data = { B: 1, a: 2 };
        const diff = diffOf([{ data, type: "insert" }]);

        expect(derivedKeys(applyDiff(new Map(), diff))).toStrictEqual([expectedDerivedId(diff, data)]);
    });

    it("collapses two identical id-less inserts within one diff onto one row", () => {
        expect.assertions(1);

        // Content IS the identity. Nothing downstream can tell two id-less rows
        // carrying the same data apart — not the next frame either — so one row
        // is the only answer that stays stable across replays.
        const next = applyDiff(
            new Map(),
            diffOf([
                { data: { name: "same" }, type: "insert" },
                { data: { name: "same" }, type: "insert" },
            ]),
        );

        expect(next.size).toBe(1);
    });

    it("keys the same row identically across diffs that differ in id and timestamp", () => {
        expect.assertions(1);

        // `subscribeToMirror` stamps every frame with `Date.now()`, so a digest
        // over the diff's identity minted a fresh key per frame and the mirror
        // grew by one row per frame forever.
        const a = applyDiff(new Map(), { changes: [{ data: { name: "x" }, type: "insert" }], id: "diff-a", table: "users", timestamp: 1 });
        const b = applyDiff(new Map(), { changes: [{ data: { name: "x" }, type: "insert" }], id: "diff-b", table: "users", timestamp: 2 });

        expect([...a.keys()]).toStrictEqual([...b.keys()]);
    });

    it("drops undefined object fields but keeps an undefined array element distinct from null", () => {
        expect.assertions(3);

        // An undefined-valued object entry is absent, exactly as `JSON.stringify`
        // treats it, so `{ a: 1 }` and `{ a: 1, b: undefined }` are one row...
        const withUndefined = applyDiff(new Map(), diffOf([{ data: { a: 1, b: undefined }, type: "insert" }]));
        const without = applyDiff(new Map(), diffOf([{ data: { a: 1 }, type: "insert" }]));

        expect([...withUndefined.keys()]).toStrictEqual([...without.keys()]);

        // ...while an undefined array ELEMENT keeps its own identity. `undefined`
        // in an array position is one of the things the wire encodes rather than
        // coercing (`JSON.stringify` would write `null` and lose the difference),
        // so two rows that differ only there are two rows, not one.
        const holeDiff = diffOf([{ data: { list: [1, undefined, 3] }, type: "insert" }]);
        const nullDiff = diffOf([{ data: { list: [1, null, 3] }, type: "insert" }]);

        expect(derivedKeys(applyDiff(new Map(), holeDiff))).not.toStrictEqual(derivedKeys(applyDiff(new Map(), nullDiff)));

        // The null form is pure JSON, so it still agrees with the reference.
        expect(derivedKeys(applyDiff(new Map(), nullDiff))).toStrictEqual([expectedDerivedId(nullDiff, { list: [1, null, 3] })]);
    });
});

describe("applyDiffs", () => {
    it("is equivalent to folding applyDiff over the backlog", () => {
        expect.assertions(1);

        const base = new Map([["seed", { id: "seed", n: 0 }]]);
        const backlog = [
            diffOf([{ data: { id: "a", n: 1 }, type: "insert" }], "d1"),
            diffOf([{ data: { n: 2 }, id: "a", type: "update" }], "d2"),
            diffOf([{ id: "seed", type: "delete" }], "d3"),
            diffOf([{ data: { name: "derived" }, type: "insert" }], "d4"),
        ];

        let folded = new Map<string, Record<string, unknown>>(base);

        for (const diff of backlog) {
            folded = applyDiff(folded, diff);
        }

        expect(applyDiffs(base, backlog)).toStrictEqual(folded);
    });

    it("leaves the caller's map untouched", () => {
        expect.assertions(1);

        const base = new Map([["a", { id: "a", n: 1 }]]);

        applyDiffs(base, [diffOf([{ id: "a", type: "delete" }]), diffOf([{ data: { id: "b" }, type: "insert" }])]);

        expect([...base.keys()]).toStrictEqual(["a"]);
    });

    it("returns a copy for an empty backlog", () => {
        expect.assertions(2);

        const base = new Map([["a", { id: "a" }]]);
        const next = applyDiffs(base, []);

        expect(next).not.toBe(base);
        expect(next).toStrictEqual(base);
    });
});

describe("applyDiffToSnapshot", () => {
    it("replaces only the targeted table and shares the rest by reference", () => {
        expect.assertions(3);

        const posts = new Map([["p1", { id: "p1" }]]);
        const snapshot = new Map([
            ["posts", posts],
            ["users", new Map([["u1", { id: "u1", n: 1 }]])],
        ]);

        const next = applyDiffToSnapshot(snapshot, diffOf([{ data: { n: 2 }, id: "u1", type: "update" }]));

        expect(next.get("posts")).toBe(posts);
        expect(next.get("users")?.get("u1")).toStrictEqual({ id: "u1", n: 2 });
        expect(snapshot.get("users")?.get("u1")).toStrictEqual({ id: "u1", n: 1 });
    });

    it("creates the table when the snapshot has no entry for it", () => {
        expect.assertions(1);

        const next = applyDiffToSnapshot(new Map(), diffOf([{ data: { id: "u1" }, type: "insert" }]));

        expect(next.get("users")?.get("u1")).toStrictEqual({ id: "u1" });
    });
});
