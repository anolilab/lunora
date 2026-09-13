import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchema, defineTable } from "../src/schema";

/**
 * `.dropStalePatches()` records its opt-in on `dropStalePatchesMode` (named so it
 * doesn't collide with the fluent method, like `commitOrdered()`/
 * `commitOrderedMode`).
 *
 * The one guard worth a test is the `.global()` rejection. The stale check reads
 * the caller's baseline out of the shard's `__cdc_log`, and a D1-backed table has
 * no entries there — so the flag would be silently inert, which is the exact
 * failure it exists to prevent: a table that looks protected and is not.
 */
describe("defineTable().dropStalePatches()", () => {
    it("records the opt-in and leaves the shape alone", () => {
        expect.assertions(2);

        const table = defineTable({ title: v.string() }).dropStalePatches();

        expect(table.dropStalePatchesMode).toBe(true);
        expect(Object.keys(table.shape)).toStrictEqual(["title"]);
    });

    it("is absent unless declared", () => {
        expect.assertions(1);

        expect(defineTable({ title: v.string() }).dropStalePatchesMode).toBe(false);
    });

    it.each([
        ["global() first", () => defineTable({ title: v.string() }).global().dropStalePatches()],
        ["dropStalePatches() first", () => defineTable({ title: v.string() }).dropStalePatches().global()],
    ])("rejects .global() + .dropStalePatches() (%s)", (_label, build) => {
        expect.assertions(1);

        // Chain order must not decide this: the rejection lives in `defineSchema`,
        // which sees the finished table either way.
        expect(() => defineSchema({ documents: build() })).toThrow(/global\(\) and \.dropStalePatches\(\)/u);
    });

    it("accepts a shard-local table", () => {
        expect.assertions(1);

        const schema = defineSchema({ documents: defineTable({ title: v.string() }).dropStalePatches() });

        expect(schema.tables["documents"]?.dropStalePatchesMode).toBe(true);
    });
});
