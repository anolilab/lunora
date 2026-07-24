import { describe, expect, it } from "vitest";

import { applyDiff, applyDiffs, applyDiffToSnapshot } from "../src/apply-diff";
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
        hash ^= BigInt(input.codePointAt(index) ?? 0);
        hash = (hash * prime) & mask64;
    }

    return hash.toString(16).padStart(16, "0");
    /* eslint-enable no-bitwise */
};

/** Recreate the exact hash input `deriveInsertId` builds, via a canonicalizing replacer. */
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

const expectedDerivedId = (diff: TableDiff, changeIndex: number, data: Record<string, unknown>): string =>
    `row-${referenceFnv1a64(`${diff.table}::${diff.id ?? String(diff.timestamp)}::${String(changeIndex)}::${JSON.stringify(canonicalize(data))}`)}`;

const onlyDerivedKey = (rows: Map<string, Record<string, unknown>>): string => {
    const keys = [...rows.keys()].filter((key) => key.startsWith("row-"));

    expect(keys).toHaveLength(1);

    return keys[0] as string;
};

describe("applyDiff", () => {
    it("leaves the caller's map untouched", () => {
        const current = new Map([["a", { id: "a", n: 1 }]]);

        const next = applyDiff(current, diffOf([{ id: "a", type: "delete" }]));

        expect(current.has("a")).toBe(true);
        expect(next.has("a")).toBe(false);
    });

    it("merges updates onto the existing row and skips unknown rows", () => {
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
        const next = applyDiff(new Map(), diffOf([{ data: { id: 42, name: "n" }, type: "insert" }]));

        expect(next.get("42")).toStrictEqual({ id: "42", name: "n" });
    });
});

describe("deriveInsertId (via id-less inserts)", () => {
    it("matches the BigInt FNV-1a reference digest", () => {
        const data = { body: "hello world", tags: ["a", "b"] };
        const diff = diffOf([{ data, type: "insert" }]);

        const next = applyDiff(new Map(), diff);

        expect(onlyDerivedKey(next)).toBe(expectedDerivedId(diff, 0, data));
    });

    it("matches the reference digest for astral code points", () => {
        const data = { note: "🎉 party \u{10FFFF}", who: "é中文" };
        const diff = diffOf([{ data, type: "insert" }]);

        const next = applyDiff(new Map(), diff);

        expect(onlyDerivedKey(next)).toBe(expectedDerivedId(diff, 0, data));
    });

    it("derives the same id when the same diff is replayed", () => {
        const diff = diffOf([{ data: { name: "alice" }, type: "insert" }]);

        expect([...applyDiff(new Map(), diff).keys()]).toStrictEqual([...applyDiff(new Map(), diff).keys()]);
    });

    it("is insensitive to key insertion order at any depth", () => {
        const shallow = applyDiff(new Map(), diffOf([{ data: { a: 1, b: 2 }, type: "insert" }]));
        const shallowReordered = applyDiff(new Map(), diffOf([{ data: { b: 2, a: 1 }, type: "insert" }]));

        expect([...shallow.keys()]).toStrictEqual([...shallowReordered.keys()]);

        const nested = applyDiff(new Map(), diffOf([{ data: { outer: { x: 1, y: { p: 1, q: 2 } } }, type: "insert" }]));
        const nestedReordered = applyDiff(new Map(), diffOf([{ data: { outer: { y: { q: 2, p: 1 }, x: 1 } }, type: "insert" }]));

        expect([...nested.keys()]).toStrictEqual([...nestedReordered.keys()]);
    });

    it("sorts keys by code unit, not by locale collation", () => {
        // "B" (0x42) sorts before "a" (0x61) by code unit, but AFTER it under
        // ICU collation — so this pair is exactly where a localeCompare-based
        // canonicalizer would disagree with the reference, and where two
        // clients in different locales would previously derive different ids.
        const data = { B: 1, a: 2 };
        const diff = diffOf([{ data, type: "insert" }]);

        expect(onlyDerivedKey(applyDiff(new Map(), diff))).toBe(expectedDerivedId(diff, 0, data));
    });

    it("distinguishes two identical id-less inserts within one diff", () => {
        const next = applyDiff(
            new Map(),
            diffOf([
                { data: { name: "same" }, type: "insert" },
                { data: { name: "same" }, type: "insert" },
            ]),
        );

        expect(next.size).toBe(2);
    });

    it("distinguishes diffs that share a timestamp but differ in id", () => {
        const a = applyDiff(new Map(), diffOf([{ data: { name: "x" }, type: "insert" }], "diff-a"));
        const b = applyDiff(new Map(), diffOf([{ data: { name: "x" }, type: "insert" }], "diff-b"));

        expect([...a.keys()]).not.toStrictEqual([...b.keys()]);
    });

    it("matches JSON.stringify's treatment of undefined in objects and arrays", () => {
        // JSON.stringify omits undefined-valued object entries, so `{ a: 1 }`
        // and `{ a: 1, b: undefined }` must canonicalize identically...
        const withUndefined = applyDiff(new Map(), diffOf([{ data: { a: 1, b: undefined }, type: "insert" }]));
        const without = applyDiff(new Map(), diffOf([{ data: { a: 1 }, type: "insert" }]));

        expect([...withUndefined.keys()]).toStrictEqual([...without.keys()]);

        // ...while an undefined array *element* becomes null, so it stays distinct.
        const holeData = { list: [1, undefined, 3] };
        const holeDiff = diffOf([{ data: holeData, type: "insert" }]);

        expect(onlyDerivedKey(applyDiff(new Map(), holeDiff))).toBe(expectedDerivedId(holeDiff, 0, { list: [1, null, 3] }));
    });
});

describe("applyDiffs", () => {
    it("is equivalent to folding applyDiff over the backlog", () => {
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
        const base = new Map([["a", { id: "a", n: 1 }]]);

        applyDiffs(base, [diffOf([{ id: "a", type: "delete" }]), diffOf([{ data: { id: "b" }, type: "insert" }])]);

        expect([...base.keys()]).toStrictEqual(["a"]);
    });

    it("returns a copy for an empty backlog", () => {
        const base = new Map([["a", { id: "a" }]]);
        const next = applyDiffs(base, []);

        expect(next).not.toBe(base);
        expect(next).toStrictEqual(base);
    });
});

describe("applyDiffToSnapshot", () => {
    it("replaces only the targeted table and shares the rest by reference", () => {
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
        const next = applyDiffToSnapshot(new Map(), diffOf([{ data: { id: "u1" }, type: "insert" }]));

        expect(next.get("users")?.get("u1")).toStrictEqual({ id: "u1" });
    });
});
