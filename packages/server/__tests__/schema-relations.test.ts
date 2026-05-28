import { describe, expect, test } from "vitest";

import { defineTable, v } from "../src/index.js";

describe("defineTable().relations", () => {
    test("table without .relations exposes an empty relationMap", () => {
        const messages = defineTable({ body: v.string() });

        expect(messages.relationMap).toEqual({});
    });

    test("records one and many descriptors keyed by accessor name", () => {
        const messages = defineTable({ authorId: v.id("users"), body: v.string() }).relations((r) => ({
            author: r.one("users", { field: "authorId", onDelete: "cascade" }),
            reactions: r.many("reactions", { field: "messageId" }),
        }));

        expect(messages.relationMap.author).toEqual({
            field: "authorId",
            kind: "one",
            onDelete: "cascade",
            references: "_id",
            table: "users",
        });
        expect(messages.relationMap.reactions).toEqual({
            field: "messageId",
            kind: "many",
            references: "_id",
            table: "reactions",
        });
    });

    test("references defaults to _id and is overridable", () => {
        const orders = defineTable({ customerSlug: v.string() }).relations((r) => ({
            customer: r.one("customers", { field: "customerSlug", references: "slug" }),
        }));

        expect(orders.relationMap.customer!.references).toBe("slug");
    });

    test("one without onDelete leaves the action undefined", () => {
        const messages = defineTable({ authorId: v.id("users") }).relations((r) => ({
            author: r.one("users", { field: "authorId" }),
        }));

        expect(messages.relationMap.author!.onDelete).toBeUndefined();
    });

    test("supports self-referential relations", () => {
        const categories = defineTable({ parentId: v.id("categories") }).relations((r) => ({
            children: r.many("categories", { field: "parentId" }),
            parent: r.one("categories", { field: "parentId" }),
        }));

        expect(categories.relationMap.parent!.table).toBe("categories");
        expect(categories.relationMap.children!.table).toBe("categories");
    });

    test(".relations returns the same builder instance", () => {
        const builder = defineTable({ authorId: v.id("users") });
        const chained = builder.relations((r) => ({ author: r.one("users", { field: "authorId" }) }));

        expect(chained).toBe(builder);
    });

    test("chains alongside other builder methods", () => {
        const messages = defineTable({ authorId: v.id("users"), body: v.string() })
            .index("by_author", ["authorId"])
            .relations((r) => ({ author: r.one("users", { field: "authorId" }) }));

        expect(messages.indexes).toHaveLength(1);
        expect(Object.keys(messages.relationMap)).toEqual(["author"]);
    });
});
