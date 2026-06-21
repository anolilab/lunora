import { describe, expect, it } from "vitest";

import { defineTable, v } from "../src/index";

describe("defineTable().relations", () => {
    it("table without .relations exposes an empty relationMap", () => {
        expect.assertions(1);

        const messages = defineTable({ body: v.string() });

        expect(messages.relationMap).toEqual({});
    });

    it("records one and many descriptors keyed by accessor name", () => {
        expect.assertions(2);

        const messages = defineTable({ authorId: v.id("users"), body: v.string() }).relations((r) => {
            return {
                author: r.one("users", { field: "authorId", onDelete: "cascade" }),
                reactions: r.many("reactions", { field: "messageId" }),
            };
        });

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

    it("references defaults to _id and is overridable", () => {
        expect.assertions(1);

        const orders = defineTable({ customerSlug: v.string() }).relations((r) => {
            return {
                customer: r.one("customers", { field: "customerSlug", references: "slug" }),
            };
        });

        expect(orders.relationMap.customer!.references).toBe("slug");
    });

    it("one without onDelete leaves the action undefined", () => {
        expect.assertions(1);

        const messages = defineTable({ authorId: v.id("users") }).relations((r) => {
            return {
                author: r.one("users", { field: "authorId" }),
            };
        });

        expect(messages.relationMap.author!.onDelete).toBeUndefined();
    });

    it("supports self-referential relations", () => {
        expect.assertions(2);

        const categories = defineTable({ parentId: v.id("categories") }).relations((r) => {
            return {
                children: r.many("categories", { field: "parentId" }),
                parent: r.one("categories", { field: "parentId" }),
            };
        });

        expect(categories.relationMap.parent!.table).toBe("categories");
        expect(categories.relationMap.children!.table).toBe("categories");
    });

    it(".relations returns the same builder instance", () => {
        expect.assertions(1);

        const builder = defineTable({ authorId: v.id("users") });
        const chained = builder.relations((r) => {
            return { author: r.one("users", { field: "authorId" }) };
        });

        expect(chained).toBe(builder);
    });

    it("chains alongside other builder methods", () => {
        expect.assertions(2);

        const messages = defineTable({ authorId: v.id("users"), body: v.string() })
            .index("by_author", ["authorId"])
            .relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            });

        expect(messages.indexes).toHaveLength(1);
        expect(Object.keys(messages.relationMap)).toEqual(["author"]);
    });
});
