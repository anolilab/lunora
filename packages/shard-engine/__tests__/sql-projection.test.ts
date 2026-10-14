import { DatabaseSync } from "node:sqlite";

import { isLunoraError } from "@lunora/errors";
import { describe, expect, it } from "vitest";

import { BIGINT_KEY_DIGITS, isProjectedKind, mayHoldProjectedValue, sqlComparableProjection } from "../src/sql-projection";

/**
 * The projection's ordering contract, which every `filter` range, `withIndex`
 * range and `ORDER BY` over a `v.bigint()` column rests on:
 *
 * `sign(key(a) compared to key(b)) === sign(a - b)`
 *
 * A property test rather than a handful of examples because the failure mode is
 * a *band* of values, not a point — the first version of this projection was
 * exactly right below 2^53 and silently wrong above it, which every
 * example-based test in the suite passed straight through.
 */
const compare = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

const sign = (value: bigint): number => {
    if (value < 0n) {
        return -1;
    }

    return value > 0n ? 1 : 0;
};

const key = (value: bigint): string => sqlComparableProjection(value) as string;

/** Boundaries worth naming: zero, the sign crossover, either side of 2^53, and the width limit. */
const BOUNDARIES = [
    0n,
    1n,
    -1n,
    9_007_199_254_740_991n,
    9_007_199_254_740_992n,
    9_007_199_254_740_993n,
    -9_007_199_254_740_993n,
    10n ** 38n,
    -(10n ** 38n),
    10n ** 39n - 1n,
    -(10n ** 39n - 1n),
];

const LCG_MODULUS = 2n ** 64n;

/** Deterministic pseudo-random bigints spanning the representable band, so a rerun tests the same pairs. */
const generated = (): bigint[] => {
    const values: bigint[] = [];
    let state = 0x2_f6_e2_b1n;

    for (let index = 0; index < 200; index += 1) {
        state = (state * 6_364_136_223_846_793_005n + 1_442_695_040_888_963_407n) % LCG_MODULUS;

        // Cycle the magnitude across 1..38 digits so the pairs span the whole
        // representable band rather than clustering at one width.
        const width = 10n ** BigInt(1 + (index % 38));
        const magnitude = state % width;

        values.push(index % 2 === 0 ? magnitude : -magnitude);
    }

    return values;
};

describe("sqlComparableProjection", () => {
    describe("bigint ordering", () => {
        it("orders every generated pair the way the numbers order", () => {
            expect.assertions(1);

            const values = [...BOUNDARIES, ...generated()];
            const mismatches: string[] = [];

            for (const a of values) {
                for (const b of values) {
                    if (compare(key(a), key(b)) !== sign(a - b)) {
                        mismatches.push(`${a.toString()} vs ${b.toString()}`);
                    }
                }
            }

            expect(mismatches).toStrictEqual([]);
        });

        it("orders the same way under a real SQLite ORDER BY", () => {
            expect.assertions(1);

            // The JS comparison above is UTF-16 code units; SQLite's BINARY
            // collation is UTF-8 bytes. The keys are ASCII so the two agree, but
            // that is the assumption worth pinning rather than assuming.
            const database = new DatabaseSync(":memory:");

            try {
                database.prepare("CREATE TABLE k (v TEXT)").all();

                const values = [...BOUNDARIES, ...generated()];

                for (const value of values) {
                    database.prepare("INSERT INTO k VALUES (?)").all(key(value));
                }

                const sorted = (database.prepare("SELECT v FROM k ORDER BY v ASC").all() as { v: string }[]).map((row) => row.v);
                const expected = values.toSorted((a, b) => sign(a - b)).map((value) => key(value));

                expect(sorted).toStrictEqual(expected);
            } finally {
                database.close();
            }
        });

        it("round-trips the sign boundary without collapsing zero", () => {
            expect.assertions(2);

            expect(key(0n)).not.toBe(key(-1n));
            expect(compare(key(-1n), key(0n))).toBe(-1);
        });
    });

    describe("width limit", () => {
        it("refuses a magnitude wider than the key, rather than mis-sorting it", () => {
            expect.assertions(3);

            const widest = 10n ** BigInt(BIGINT_KEY_DIGITS) - 1n;

            expect(key(widest)).toHaveLength(BIGINT_KEY_DIGITS + 1);

            // The legacy format stored a bigint of any width, so this is
            // reachable from real data — a uint256 balance is 78 digits.
            const error = ((): unknown => {
                try {
                    return sqlComparableProjection(10n ** BigInt(BIGINT_KEY_DIGITS));
                } catch (error_: unknown) {
                    return error_;
                }
            })();

            expect(isLunoraError(error)).toBe(true);
            expect((error as Error).message).toContain("digit limit");
        });
    });

    describe("kind predicates", () => {
        it("sees through v.optional() to the projected kind", () => {
            expect.assertions(4);

            // The defect this pair exists to stop: every guard dispatched on the
            // declared `kind`, which is `"optional"`, while the projection
            // dispatches on the runtime type — so an optional bigint was
            // projected but never guarded, and `sum` returned 2e+39.
            const optionalBigint = { _meta: { inner: { kind: "bigint" } }, kind: "optional" };

            expect(isProjectedKind(optionalBigint)).toBe(true);
            expect(isProjectedKind({ _meta: { inner: { kind: "bytes" } }, kind: "optional" })).toBe(true);
            expect(isProjectedKind({ kind: "string" })).toBe(false);
            expect(isProjectedKind({ _meta: { inner: { kind: "string" } }, kind: "optional" })).toBe(false);
        });

        it("treats an untyped field as able to hold a projected value", () => {
            expect.assertions(4);

            // `v.any()` commits to nothing and can hold a bigint, which the
            // projection then projects on runtime type. The backfill must scan
            // such a field or it reports a clean table that is not clean.
            expect(mayHoldProjectedValue({ kind: "any" })).toBe(true);
            expect(mayHoldProjectedValue({ kind: "union" })).toBe(true);
            expect(mayHoldProjectedValue({ _meta: { inner: { kind: "any" } }, kind: "optional" })).toBe(true);
            expect(mayHoldProjectedValue({ kind: "string" })).toBe(false);
        });
    });
});
