import { describe, expect, it } from "vitest";

import type { AggregateTally } from "../src/aggregate-tally";
import { aggregateTableName, coerceAggregateNumber, encodeAggregateKey, foldAggregateTally, readAggregateValue } from "../src/aggregate-tally";
import type { AggregateIndexDefinitionLike } from "../src/schema-types";

/**
 * Shared aggregate-companion primitives maintained byte-for-byte identically
 * by the DO and D1 ctx-db dialects. Pure functions, so these pin the
 * dialect-agnostic behaviour both backends must reproduce.
 */

describe(aggregateTableName, () => {
    it("namespaces the companion table under the reserved __agg_ infix", () => {
        expect.assertions(1);

        expect(aggregateTableName("orders", "by_status")).toBe("orders__agg_by_status");
    });
});

describe(coerceAggregateNumber, () => {
    it("passes through a finite number", () => {
        expect.assertions(1);

        expect(coerceAggregateNumber(42)).toBe(42);
    });

    it("treats NaN and Infinity as non-numeric", () => {
        expect.assertions(2);

        expect(coerceAggregateNumber(Number.NaN)).toBeUndefined();
        expect(coerceAggregateNumber(Number.POSITIVE_INFINITY)).toBeUndefined();
    });

    it("treats a numeric string, null, undefined and objects as non-numeric", () => {
        expect.assertions(4);

        expect(coerceAggregateNumber("42")).toBeUndefined();
        expect(coerceAggregateNumber(null)).toBeUndefined();
        expect(coerceAggregateNumber(undefined)).toBeUndefined();
        expect(coerceAggregateNumber({})).toBeUndefined();
    });
});

describe(encodeAggregateKey, () => {
    it("keys the whole-table aggregate (empty by) on the empty string", () => {
        expect.assertions(1);

        expect(encodeAggregateKey([], { status: "open" })).toBe("");
    });

    it("is stable across field order in the by-tuple", () => {
        expect.assertions(1);

        expect(encodeAggregateKey(["b", "a"], { a: 1, b: 2 })).toBe(encodeAggregateKey(["a", "b"], { a: 1, b: 2 }));
    });

    it("never misses a lookup for the same logical group, regardless of source key order", () => {
        expect.assertions(1);

        const insertedAsAB = encodeAggregateKey(["a", "b"], { a: 1, b: 2 });
        const insertedAsBA = encodeAggregateKey(["a", "b"], { b: 2, a: 1 });

        expect(insertedAsAB).toBe(insertedAsBA);
    });

    it("encodes a missing by-field as null rather than dropping it", () => {
        expect.assertions(1);

        expect(encodeAggregateKey(["a", "missing"], { a: 1 })).toBe(JSON.stringify({ a: 1, missing: null }));
    });
});

describe(readAggregateValue, () => {
    it("reads count as 0 for an absent group, never null", () => {
        expect.assertions(2);

        expect(readAggregateValue("count", undefined)).toBe(0);
        expect(readAggregateValue("count", { count: 0, value: 0 })).toBe(0);
    });

    it("reads sum/min/max as null for an absent or empty group", () => {
        expect.assertions(6);

        for (const op of ["sum", "min", "max"]) {
            expect(readAggregateValue(op, undefined)).toBeNull();
            expect(readAggregateValue(op, { count: 0, value: null })).toBeNull();
        }
    });

    it("reads sum/min/max verbatim from a non-empty group", () => {
        expect.assertions(3);

        expect(readAggregateValue("sum", { count: 3, value: 42 })).toBe(42);
        expect(readAggregateValue("min", { count: 3, value: 1 })).toBe(1);
        expect(readAggregateValue("max", { count: 3, value: 9 })).toBe(9);
    });

    it("divides sum by count for avg", () => {
        expect.assertions(1);

        expect(readAggregateValue("avg", { count: 4, value: 10 })).toBe(2.5);
    });

    it("reads avg as null when the divisor (count) is 0", () => {
        expect.assertions(1);

        expect(readAggregateValue("avg", { count: 0, value: null })).toBeNull();
    });
});

describe(foldAggregateTally, () => {
    const countIndex: AggregateIndexDefinitionLike = { name: "by_status", on: "orders", op: "count" };
    const sumIndex: AggregateIndexDefinitionLike = { field: "total", name: "by_status_sum", on: "orders", op: "sum" };
    const avgIndex: AggregateIndexDefinitionLike = { field: "total", name: "by_status_avg", on: "orders", op: "avg" };
    const minIndex: AggregateIndexDefinitionLike = { field: "total", name: "by_status_min", on: "orders", op: "min" };
    const maxIndex: AggregateIndexDefinitionLike = { field: "total", name: "by_status_max", on: "orders", op: "max" };

    it("count: tallies every row regardless of field values", () => {
        expect.assertions(1);

        const tallies = new Map<string, AggregateTally>();

        foldAggregateTally(tallies, "open", countIndex, {});
        foldAggregateTally(tallies, "open", countIndex, {});
        foldAggregateTally(tallies, "open", countIndex, {});

        expect(tallies.get("open")).toStrictEqual({ count: 3, value: 3 });
    });

    it("sum: accumulates only numeric field values, and skips non-numeric ones", () => {
        expect.assertions(1);

        const tallies = new Map<string, AggregateTally>();

        foldAggregateTally(tallies, "open", sumIndex, { total: 10 });
        foldAggregateTally(tallies, "open", sumIndex, { total: 5 });
        foldAggregateTally(tallies, "open", sumIndex, { total: "not a number" });

        // Non-numeric row neither shifts the running sum nor counts toward the divisor.
        expect(tallies.get("open")).toStrictEqual({ count: 2, value: 15 });
    });

    it("avg: shares the same accumulator shape as sum (count is avg's divisor)", () => {
        expect.assertions(1);

        const tallies = new Map<string, AggregateTally>();

        foldAggregateTally(tallies, "open", avgIndex, { total: 10 });
        foldAggregateTally(tallies, "open", avgIndex, { total: 20 });

        expect(tallies.get("open")).toStrictEqual({ count: 2, value: 30 });
    });

    it("min/max: every row counts toward the group, but only numeric ones move the extreme", () => {
        expect.assertions(2);

        const minTallies = new Map<string, AggregateTally>();

        foldAggregateTally(minTallies, "open", minIndex, { total: 5 });
        foldAggregateTally(minTallies, "open", minIndex, { total: 1 });
        // A non-numeric row still counts (so the group reads non-empty) but doesn't move the extreme.
        foldAggregateTally(minTallies, "open", minIndex, { total: "n/a" });

        expect(minTallies.get("open")).toStrictEqual({ count: 3, value: 1 });

        const maxTallies = new Map<string, AggregateTally>();

        foldAggregateTally(maxTallies, "open", maxIndex, { total: 5 });
        foldAggregateTally(maxTallies, "open", maxIndex, { total: 9 });

        expect(maxTallies.get("open")).toStrictEqual({ count: 2, value: 9 });
    });

    it("min/max: a group with only non-numeric rows counts as non-empty with a null extreme", () => {
        expect.assertions(1);

        const tallies = new Map<string, AggregateTally>();

        foldAggregateTally(tallies, "open", minIndex, { total: "n/a" });

        expect(tallies.get("open")).toStrictEqual({ count: 1, value: null });
    });

    it("folds into separate groups keyed by the caller-supplied encoded key", () => {
        expect.assertions(1);

        const tallies = new Map<string, AggregateTally>();

        foldAggregateTally(tallies, "open", countIndex, {});
        foldAggregateTally(tallies, "closed", countIndex, {});
        foldAggregateTally(tallies, "closed", countIndex, {});

        expect([...tallies.entries()]).toStrictEqual([
            ["open", { count: 1, value: 1 }],
            ["closed", { count: 2, value: 2 }],
        ]);
    });
});
