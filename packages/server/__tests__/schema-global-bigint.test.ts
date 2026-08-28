/**
 * `v.bigint()` on a `.global()` table is refused at definition.
 *
 * A shard table stores a bigint as an order-preserving sort key, so ordering,
 * ranges and aggregates are exact. A global table lands in D1/Hyperdrive as
 * decimal TEXT, where SQL compares lexicographically — `"100" < "25" < "9"` —
 * so every ordered read is silently wrong. This is the same posture
 * `.commitOrdered()` takes for the same reason: refuse the combination rather
 * than ship a column whose contract does not hold on the backend it reaches.
 */
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchema, defineTable } from "../src/schema";

describe("v.bigint() on a global table", () => {
    it("is refused whichever order the chain is written in", () => {
        expect.assertions(2);

        expect(() => defineSchema({ ledger: defineTable({ amount: v.bigint() }).global() })).toThrow(/\.global\(\) and column "amount" is v\.bigint\(\)/u);
        expect(() => defineSchema({ ledger: defineTable({ amount: v.bigint(), name: v.string() }).global() })).toThrow(/lexicographically/u);
    });

    it("sees through v.optional(), which stores exactly like its inner column", () => {
        expect.assertions(1);

        expect(() => defineSchema({ ledger: defineTable({ amount: v.optional(v.bigint()) }).global() })).toThrow(/is v\.bigint\(\)/u);
    });

    it("leaves a bigint on a shard table alone — there the sort key is exact", () => {
        expect.assertions(2);

        expect(() => defineSchema({ ledger: defineTable({ amount: v.bigint() }) })).not.toThrow();
        expect(() => defineSchema({ ledger: defineTable({ amount: v.optional(v.bigint()) }) })).not.toThrow();
    });

    it("leaves other column kinds on a global table alone", () => {
        expect.assertions(1);

        expect(() => defineSchema({ feed: defineTable({ blob: v.bytes(), title: v.string() }).global() })).not.toThrow();
    });
});
