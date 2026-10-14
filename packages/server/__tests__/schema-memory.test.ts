import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { defineSchema, defineTable } from "../src/schema";

/**
 * `.memory()` records its opt-in on `memoryMode` (named so it doesn't collide
 * with the fluent method, like `shardBy()`/`shardMode`).
 *
 * The rejections are the interesting half. Each combination below is one
 * `.memory()` cannot honour: the first three because clearing the table would
 * contradict what the other modifier promises, the rest because clearing is a
 * `DELETE FROM` on the base table and every companion kind lives somewhere the
 * delete does not reach.
 */
describe("defineTable().memory()", () => {
    it("records the opt-in and leaves the shape alone", () => {
        expect.assertions(2);

        const table = defineTable({ status: v.string() }).memory();

        expect(table.memoryMode).toBe(true);
        expect(Object.keys(table.shape)).toStrictEqual(["status"]);
    });

    it("is false on a table that never opted in", () => {
        expect.assertions(1);

        expect(defineTable({ status: v.string() }).memoryMode).toBe(false);
    });

    it.each([
        [".global()", () => defineTable({ status: v.string() }).memory().global()],
        [".commitOrdered()", () => defineTable({ status: v.string() }).memory().commitOrdered()],
        [".searchIndex()", () => defineTable({ status: v.string() }).memory().searchIndex("by_status", { field: "status" })],
        [".geoIndex()", () => defineTable({ at: v.geoPoint(), status: v.string() }).memory().geoIndex("by_at", { field: "at" })],
        [".aggregateIndex()", () => defineTable({ status: v.string() }).memory().aggregateIndex("total")],
        [
            ".rankIndex()",
            () =>
                defineTable({ score: v.number() })
                    .memory()
                    .rankIndex("by_score", { sortBy: [{ field: "score" }] }),
        ],
    ])("rejects %s alongside .memory()", (_label, build) => {
        expect.assertions(1);

        expect(() => defineSchema({ ephemeral: build() })).toThrow(/is both \.memory\(\) and/u);
    });

    it("rejects the conflicting modifier in either chain order", () => {
        expect.assertions(1);

        // `.memory()` and its conflicts are both order-independent facts about the
        // assembled table, which is why the guard runs at defineSchema.
        expect(() => defineSchema({ ephemeral: defineTable({ status: v.string() }).global().memory() })).toThrow(/is both \.memory\(\) and \.global\(\)/u);
    });

    it("allows a plain .index() — SQLite maintains it through the DELETE", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                presence: defineTable({ roomId: v.string(), userId: v.string() }).memory().index("by_room", ["roomId"]),
            }),
        ).not.toThrow();
    });
});
