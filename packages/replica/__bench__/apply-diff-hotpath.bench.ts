import { bench, describe } from "vitest";

import { applyDiff, applyDiffs } from "../src/apply-diff";
import type { RowChange, TableDiff } from "../src/table-diff";

/*
 * Old-vs-new contrast for the `applyDiff` hot-path optimizations:
 *
 * 1. `applyDiffs` folds the whole backlog into ONE map copy. It previously
 *    copied the input map and then copied again inside `applyDiff` per diff —
 *    N+1 copies for N diffs, despite its docstring claiming the opposite.
 * 2. The derived-insert-id hash runs 64-bit FNV-1a over four 16-bit number
 *    limbs instead of `BigInt`, which allocated a heap object per character.
 * 3. Canonicalization streams straight into the hash input instead of building
 *    a fully canonicalized copy of the value tree and re-walking it with
 *    `JSON.stringify`.
 *
 * Each `*-baseline` bench re-implements the pre-optimization shape inline over
 * the same fixtures so the relative win is demonstrable in one run.
 */

// ---- Fixtures ------------------------------------------------------------

const seedRows = (count: number): Map<string, Record<string, unknown>> => {
    const rows = new Map<string, Record<string, unknown>>();

    for (let index = 0; index < count; index += 1) {
        rows.set(`row-${String(index)}`, { id: `row-${String(index)}`, name: `user-${String(index)}`, score: index });
    }

    return rows;
};

const baseRows = seedRows(500);

const makeDiff = (changes: RowChange[], id: string): TableDiff => {
    return { changes, id, table: "users", timestamp: 1_700_000_000_000 };
};

const backlog = Array.from({ length: 64 }, (_, index) =>
    makeDiff(
        [
            { data: { id: `bl-${String(index)}`, name: `bl-${String(index)}`, score: index }, type: "insert" },
            { data: { score: index }, id: `row-${String(index % 500)}`, type: "update" },
        ],
        `diff-backlog-${String(index)}`,
    ),
);

const nestedPayload = (index: number): Record<string, unknown> => {
    return {
        author: { email: `u${String(index)}@example.com`, id: `u-${String(index)}`, name: `user ${String(index)}` },
        body: `message body number ${String(index)} with some prose in it`,
        meta: { attachments: [{ size: 1024, url: "https://example.com/a" }], edited: false, reactions: { "+1": index, heart: 2 } },
        tags: ["alpha", "beta", "gamma"],
    };
};

const nestedInsertDiff = makeDiff(
    Array.from({ length: 50 }, (_, index) => {
        return { data: nestedPayload(index), type: "insert" } satisfies RowChange;
    }),
    "diff-nested",
);

// ---- Baselines (pre-optimization shapes) ---------------------------------

/** Pre-optimization `applyDiffs`: one map copy up front, plus one more per diff. */
const applyDiffsBaseline = (current: ReadonlyMap<string, Record<string, unknown>>, diffs: ReadonlyArray<TableDiff>): Map<string, Record<string, unknown>> => {
    let result = new Map(current);

    for (const diff of diffs) {
        result = applyDiff(result, diff);
    }

    return result;
};

/** Pre-optimization canonicalizer: builds a fully canonicalized copy of the tree. */
const canonicalizeForHashBaseline = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeForHashBaseline(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
        const result: Record<string, unknown> = {};

        for (const key of sortedKeys) {
            result[key] = canonicalizeForHashBaseline(record[key]);
        }

        return result;
    }

    return value;
};

/** Pre-optimization derived id: canonicalize + stringify, then BigInt FNV-1a. */
const deriveInsertIdBaseline = (diff: TableDiff, changeIndex: number, data: Record<string, unknown>): string => {
    const diffIdentity = diff.id ?? String(diff.timestamp);
    const input = `${diff.table}::${diffIdentity}::${String(changeIndex)}::${JSON.stringify(canonicalizeForHashBaseline(data))}`;

    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication */
    let hash = 0xcb_f2_9c_e4_84_22_23_25n;

    const prime = 0x00_00_01_00_00_00_01_b3n;
    const mask64 = 0xff_ff_ff_ff_ff_ff_ff_ffn;

    for (let index = 0; index < input.length; index += 1) {
        hash ^= BigInt(input.codePointAt(index) ?? 0);
        hash = (hash * prime) & mask64;
    }

    return `row-${hash.toString(16).padStart(16, "0")}`;
    /* eslint-enable no-bitwise */
};

/** Pre-optimization `applyDiff` insert path, driven over the same 50 id-less inserts. */
const applyDerivedInsertsBaseline = (current: ReadonlyMap<string, Record<string, unknown>>, diff: TableDiff): Map<string, Record<string, unknown>> => {
    const next = new Map(current);

    for (const [changeIndex, change] of diff.changes.entries()) {
        if (change.type === "insert") {
            const rawId = (change.data as { id?: unknown }).id;
            const id = typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : deriveInsertIdBaseline(diff, changeIndex, change.data);

            next.set(id, { ...change.data, id });
        }
    }

    return next;
};

// ---- Benches -------------------------------------------------------------

describe("applyDiffs — 64-diff catch-up backlog over a 500-row map", () => {
    bench("optimized (single map copy for the whole backlog)", () => {
        applyDiffs(baseRows, backlog);
    });

    bench("baseline (one map copy per diff)", () => {
        applyDiffsBaseline(baseRows, backlog);
    });
});

describe("derived insert ids — 50 id-less inserts with a nested payload", () => {
    bench("optimized (streamed canonical JSON + limb FNV-1a)", () => {
        applyDiff(baseRows, nestedInsertDiff);
    });

    bench("baseline (canonicalized copy + JSON.stringify + BigInt FNV-1a)", () => {
        applyDerivedInsertsBaseline(baseRows, nestedInsertDiff);
    });
});
