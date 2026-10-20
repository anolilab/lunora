import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { seedPlan } from "../src/plan";

const rowsOf = (plan: ReturnType<typeof seedPlan>, table: string): ReadonlyArray<Record<string, unknown>> => plan.find((entry) => entry.table === table)!.rows;

describe("seedPlan — multi-column unique indexes", () => {
    const through = defineSchema({
        authors: defineTable({ name: v.string() }),
        books: defineTable({ title: v.string() }),
        authorBooks: defineTable({ authorId: v.id("authors"), bookId: v.id("books") }).index("by_author_book", ["authorId", "bookId"], { unique: true }),
    });

    it("seeds a through table up to N x M distinct pairs", () => {
        expect.hasAssertions();

        const plan = seedPlan(through, { counts: { authors: 3, books: 4, authorBooks: 12 } });
        const pairs = new Set(rowsOf(plan, "authorBooks").map((row) => `${row.authorId as string}|${row.bookId as string}`));

        expect(pairs.size).toBe(12);
    });

    it("refuses a through table past N x M, naming the index", () => {
        expect.hasAssertions();

        expect(() => seedPlan(through, { counts: { authors: 3, books: 4, authorBooks: 13 } })).toThrow(/by_author_book/u);
    });

    it("makes a single-column unique index behave like .unique()", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            users: defineTable({ handle: v.string() }).index("by_handle", ["handle"], { unique: true }),
        });
        const plan = seedPlan(schema, { counts: { users: 25 } });
        const handles = new Set(rowsOf(plan, "users").map((row) => row.handle));

        expect(handles.size).toBe(25);
    });
});
