import { describe, expect, it } from "vitest";

import { defineSchema, defineTable, v } from "../src/index";

/**
 * `.index(name, fields)` cross-checked against the table's ASSEMBLED shape
 * (advisor 226 / SERVER-03). Unlike `geoIndex`/`ownedBy`/`shardBy`/
 * `rankIndex.sortBy`, `.index()`'s `fields` were the one table-builder input
 * with no shape check — a typo'd column type-checked, passed `defineSchema`,
 * and only surfaced at migration time as a SQLite "no such column" error.
 * Enforced late, inside `defineSchema`, so a `.softDelete()`-injected marker
 * column (added onto `shape` during builder chaining, before `defineSchema`
 * ever runs) is already present by the time this check reads `table.shape`.
 */
describe("defineSchema validates .index() fields", () => {
    it("throws for an index field naming a column absent from the table's shape", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                posts: defineTable({ title: v.string() }).index("by_author", ["autor" as never]),
            }),
        ).toThrow(/table "posts" index "by_author" names column "autor" which is not in the table's shape/);
    });

    it("accepts the system columns _id and _creationTime alongside a real column", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                posts: defineTable({ title: v.string() }).index("by_id_and_title", ["_id", "_creationTime", "title"]),
            }),
        ).not.toThrow();
    });

    it("accepts an index over a column .softDelete() injects, regardless of chain order", () => {
        expect.assertions(1);

        // `.index()` is called before `.softDelete()` in the chain — the marker
        // column still lands on `shape` (the builder closes over the same
        // object) before `defineSchema` reads it, since both run synchronously
        // during table construction and `defineSchema` runs strictly after.
        expect(() =>
            defineSchema({
                posts: defineTable({ title: v.string() })
                    .index("by_deleted", ["deletedAt" as never])
                    .softDelete(),
            }),
        ).not.toThrow();
    });

    it("throws for a duplicate index name within a table", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                posts: defineTable({ authorId: v.string(), title: v.string() }).index("by_author", ["authorId"]).index("by_author", ["title"]),
            }),
        ).toThrow(/table "posts" declares index "by_author" more than once/);
    });

    it("does not flag distinct tables that reuse the same index name", () => {
        expect.assertions(1);

        expect(() =>
            defineSchema({
                comments: defineTable({ postId: v.string() }).index("by_owner", ["postId"]),
                posts: defineTable({ authorId: v.string() }).index("by_owner", ["authorId"]),
            }),
        ).not.toThrow();
    });
});
