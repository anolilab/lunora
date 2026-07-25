import { bench, describe } from "vitest";

import { applyDiff, applyDiffs } from "../src/apply-diff";
import type { TableDiff } from "../src/table-diff";
import { backlog, baseRows, nestedInsertDiff, nestedPayload } from "./apply-diff.shared";

/*
 * Old-vs-new contrast for the `applyDiff` hot-path optimizations. Each pair is
 * INDEPENDENTLY attributable, so a later regression in one cannot hide behind a
 * win in another:
 *
 * 1. `applyDiffs` folds the whole backlog into ONE map copy. It previously
 *    copied the input map and then copied again inside `applyDiff` per diff —
 *    N+1 copies for N diffs, despite its docstring claiming the opposite.
 * 2. The derived-insert-id hash runs 64-bit FNV-1a over four 16-bit number
 *    limbs instead of `BigInt`, which allocated a heap object per character.
 *    Benched on its own over a fixed string, so the number backs the "~8x"
 *    claim in `apply-diff.ts` directly.
 * 3. Canonicalization was NOT changed, and this pair is why. Encoding straight
 *    to a string in one pass — no intermediate copy — looks like the obvious
 *    win, but it loses: `JSON.stringify` is a native fast path that JS-side
 *    string building cannot beat. The rejected alternative stays benched so the
 *    decision is re-checkable rather than folklore, and so nobody "optimizes"
 *    it back. Read this pair as current-vs-rejected, not old-vs-new.
 * 4. The surviving changes combined, end to end through the public `applyDiff`.
 *
 * Splitting 2 and 3 apart is what surfaced this: measured together they showed
 * a healthy ~3x, which was entirely the hash carrying a slower encoder.
 *
 * Fixtures come from `apply-diff.shared.ts`, shared with `apply-diff.bench.ts`.
 */

// ---- Baselines (pre-optimization shapes) ---------------------------------

/** Pre-optimization `applyDiffs`: one map copy up front, plus one more per diff. */
const applyDiffsBaseline = (current: ReadonlyMap<string, Record<string, unknown>>, diffs: ReadonlyArray<TableDiff>): Map<string, Record<string, unknown>> => {
    let result = new Map(current);

    for (const diff of diffs) {
        result = applyDiff(result, diff);
    }

    return result;
};

/**
 * Pre-optimization canonicalizer: builds a fully canonicalized COPY of the value
 * tree, which a separate `JSON.stringify` pass then walks again.
 *
 * Named for its ordering on purpose — it sorts with `localeCompare`, the
 * locale-dependent ordering REPLICA-05 replaced with code-unit order. Do not
 * reach for this as a canonicalization reference; the code-unit reference lives
 * in `__tests__/apply-diff-canonical.test.ts`.
 */
const canonicalizeLocaleSortedPreReplica05 = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeLocaleSortedPreReplica05(item));
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const sortedKeys = Object.keys(record).toSorted((a, b) => a.localeCompare(b));
        const result: Record<string, unknown> = {};

        for (const key of sortedKeys) {
            result[key] = canonicalizeLocaleSortedPreReplica05(record[key]);
        }

        return result;
    }

    return value;
};

/** Pre-optimization hash: 64-bit FNV-1a over `BigInt`, one heap object per operation. */
const fnv1a64BigintHex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication */
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

/** Current hash: the same digest over four 16-bit limbs in plain numbers. */
const fnv1a64LimbHex = (input: string): string => {
    /* eslint-disable no-bitwise -- FNV-1a is defined over XOR and multiplication */
    let h0 = 0x23_25;
    let h1 = 0x84_22;
    let h2 = 0x9c_e4;
    let h3 = 0xcb_f2;

    for (let index = 0; index < input.length; index += 1) {
        const point = input.codePointAt(index) ?? 0;

        h0 ^= point & 0xff_ff;
        h1 ^= (point >>> 16) & 0xff_ff;

        const p0 = h0 * 0x01_b3;
        const p1 = h1 * 0x01_b3;
        const p2 = h2 * 0x01_b3 + h0 * 0x01_00;
        const p3 = h3 * 0x01_b3 + h1 * 0x01_00;

        const c1 = p1 + (p0 >>> 16);
        const c2 = p2 + (c1 >>> 16);
        const c3 = p3 + (c2 >>> 16);

        h0 = p0 & 0xff_ff;
        h1 = c1 & 0xff_ff;
        h2 = c2 & 0xff_ff;
        h3 = c3 & 0xff_ff;
    }

    return [h3, h2, h1, h0].map((limb) => limb.toString(16).padStart(4, "0")).join("");
    /* eslint-enable no-bitwise */
};

/**
 * REJECTED alternative: encode in one pass straight to a string, no intermediate
 * copy. Measured slower than the two-pass form it would have replaced (see the
 * header) and would have meant re-implementing `JSON.stringify`'s escaping,
 * `undefined` and `toJSON` rules by hand. Kept only as the bench baseline.
 */
const canonicalJsonOnePass = (value: unknown): string => {
    const unencodable = (item: unknown): boolean => item === undefined || typeof item === "function" || typeof item === "symbol";

    if (Array.isArray(value)) {
        return `[${value.map((item) => (unencodable(item) ? "null" : canonicalJsonOnePass(item))).join(",")}]`;
    }

    if (value !== null && typeof value === "object") {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record);

        keys.sort();

        return `{${keys
            .filter((key) => !unencodable(record[key]))
            .map((key) => `${JSON.stringify(key)}:${canonicalJsonOnePass(record[key])}`)
            .join(",")}}`;
    }

    return JSON.stringify(value);
};

/** Pre-optimization `applyDiff` insert path, over the same 50 id-less inserts. */
const applyDerivedInsertsBaseline = (current: ReadonlyMap<string, Record<string, unknown>>, diff: TableDiff): Map<string, Record<string, unknown>> => {
    const next = new Map(current);

    for (const [changeIndex, change] of diff.changes.entries()) {
        if (change.type === "insert") {
            const rawId = (change.data as { id?: unknown }).id;
            const identity = diff.id ?? String(diff.timestamp);
            const encoded = JSON.stringify(canonicalizeLocaleSortedPreReplica05(change.data));
            const id =
                typeof rawId === "string" || typeof rawId === "number"
                    ? String(rawId)
                    : `row-${fnv1a64BigintHex(`${diff.table}::${identity}::${String(changeIndex)}::${encoded}`)}`;

            next.set(id, { ...change.data, id });
        }
    }

    return next;
};

// ---- Fixtures ------------------------------------------------------------

/** A fixed hash input, so the hash benches measure only the arithmetic. */
const hashInput = `users::diff-nested::7::${JSON.stringify(nestedPayload(7))}`;

/** A fixed value tree, so the canonicalization benches measure only the encoding. */
const canonicalInput = nestedPayload(7);

// ---- Benches -------------------------------------------------------------

describe("applyDiffs — 64-diff catch-up backlog over a 500-row map", () => {
    bench("optimized (single map copy for the whole backlog)", () => {
        applyDiffs(baseRows, backlog);
    });

    bench("baseline (one map copy per diff)", () => {
        applyDiffsBaseline(baseRows, backlog);
    });
});

describe("64-bit FNV-1a over one fixed hash input", () => {
    bench("optimized (four 16-bit number limbs)", () => {
        fnv1a64LimbHex(hashInput);
    });

    bench("baseline (BigInt)", () => {
        fnv1a64BigintHex(hashInput);
    });
});

describe("canonical encoding of one fixed nested payload", () => {
    bench("current (canonicalized copy + native JSON.stringify)", () => {
        JSON.stringify(canonicalizeLocaleSortedPreReplica05(canonicalInput));
    });

    bench("rejected (one pass straight to a string)", () => {
        canonicalJsonOnePass(canonicalInput);
    });
});

describe("derived insert ids end to end — 50 id-less inserts, nested payload", () => {
    bench("optimized (limb FNV-1a)", () => {
        applyDiff(baseRows, nestedInsertDiff);
    });

    bench("baseline (BigInt FNV-1a + localeCompare canonicalization)", () => {
        applyDerivedInsertsBaseline(baseRows, nestedInsertDiff);
    });
});
