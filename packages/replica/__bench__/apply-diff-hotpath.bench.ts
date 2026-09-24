import { bench, describe } from "vitest";

import { stableWireKey } from "../../../shared/wire-key";
import { applyDiff, applyDiffs, fnv1a64Hex } from "../src/apply-diff";
import type { TableDiff } from "../src/table-diff";
import { backlog, baseRows, nestedInsertDiff, nestedPayload, ROW_COUNT } from "./apply-diff.shared";

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
 * 3. Content encoding moved from a key-sorted COPY handed to `JSON.stringify`
 *    to `stableWireKey`, which encodes the wire form in one pass. The move was
 *    for correctness, not speed — the copy rendered every `Date`/`Map`/`Set`/
 *    `URL`/`ArrayBuffer` as `{}` and threw on a `bigint` — so this pair exists
 *    to keep the cost of that correctness attributable rather than hidden inside
 *    the end-to-end number in 4.
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
 * reach for this as a canonicalization reference; the shipped encoder is
 * `stableWireKey`, imported above from `shared/wire-key.ts`.
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
        // Code UNITS, matching `shared/fnv1a.ts` — the two must produce the same
        // digest for this benchmark to compare the same work.
        // eslint-disable-next-line unicorn/prefer-code-point -- see above
        hash ^= BigInt(input.charCodeAt(index));
        hash = (hash * prime) & mask64;
    }

    return hash.toString(16).padStart(16, "0");
    /* eslint-enable no-bitwise */
};

/**
 * Pre-`stableWireKey` encoder: build a code-unit-key-sorted COPY of the value
 * tree, then hand it to `JSON.stringify`. Correct only for pure JSON — it
 * rendered every `Date`/`Map`/`Set`/`URL`/`ArrayBuffer` as `{}` (one shared
 * digest for all of them) and threw on a `bigint`. Kept as the bench baseline so
 * the cost of the encoder that replaced it stays attributable.
 */
const canonicalJsonSortedCopyPreWireKey = (value: unknown): string => {
    const canonicalize = (item: unknown): unknown => {
        if (Array.isArray(item)) {
            return item.map((element) => canonicalize(element));
        }

        if (item !== null && typeof item === "object") {
            const record = item as Record<string, unknown>;
            const keys = Object.keys(record);

            keys.sort();

            const result: Record<string, unknown> = {};

            for (const key of keys) {
                result[key] = canonicalize(record[key]);
            }

            return result;
        }

        return item;
    };

    return JSON.stringify(canonicalize(value));
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

describe(`applyDiffs — 64-diff catch-up backlog over a ${String(ROW_COUNT)}-row map`, () => {
    bench("optimized (single map copy for the whole backlog)", () => {
        applyDiffs(baseRows, backlog);
    });

    bench("baseline (one map copy per diff)", () => {
        applyDiffsBaseline(baseRows, backlog);
    });
});

describe("64-bit FNV-1a over one fixed hash input", () => {
    bench("optimized (four 16-bit number limbs)", () => {
        fnv1a64Hex(hashInput);
    });

    bench("baseline (BigInt)", () => {
        fnv1a64BigintHex(hashInput);
    });
});

describe("canonical encoding of one fixed nested payload", () => {
    bench("current (stableWireKey)", () => {
        stableWireKey(canonicalInput);
    });

    bench("baseline (key-sorted copy + native JSON.stringify)", () => {
        canonicalJsonSortedCopyPreWireKey(canonicalInput);
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
