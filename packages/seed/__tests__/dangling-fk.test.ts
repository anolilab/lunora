import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { createSeedClient } from "../src/client";
import { seedPlan } from "../src/plan";

const rowsOf = (plan: ReturnType<typeof seedPlan>, table: string): ReadonlyArray<Record<string, unknown>> => plan.find((entry) => entry.table === table)!.rows;

describe("seedPlan — dangling foreign keys", () => {
    const orders = defineSchema({
        orders: defineTable({ customerId: v.id("customers") }),
        customers: defineTable({ name: v.string() }),
    });

    it("refuses a required FK whose parent has no rows, naming the column", () => {
        expect.hasAssertions();

        expect(() => seedPlan(orders, { counts: { customers: 0, orders: 2 } })).toThrow(/"customerId"/u);
    });

    it("lets allowOrphans take a placeholder id instead", () => {
        expect.hasAssertions();

        const plan = seedPlan(orders, { allowOrphans: true, counts: { customers: 0, orders: 2 } });

        expect(typeof rowsOf(plan, "orders")[0]!.customerId).toBe("string");
    });

    it("does not refuse when the caller supplies the column", () => {
        expect.hasAssertions();

        const plan = seedPlan(orders, { counts: { customers: 0, orders: 1 }, overrides: { orders: { customerId: "c-1" } } });

        expect(rowsOf(plan, "orders")[0]!.customerId).toBe("c-1");
    });

    it("leaves an optional FK out and a nullable FK null when the parent is empty", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            customers: defineTable({ name: v.string() }),
            orders: defineTable({ alt: v.id("customers").nullable(), customerId: v.optional(v.id("customers")) }),
        });
        const [row] = rowsOf(seedPlan(schema, { counts: { customers: 0, orders: 1 } }), "orders");

        expect(row).not.toHaveProperty("customerId");
        expect(row!.alt).toBeNull();
    });

    it("refuses a required self-reference that has no row to point at", () => {
        expect.hasAssertions();

        const schema = defineSchema({ nodes: defineTable({ parentId: v.id("nodes") }) });

        expect(() => seedPlan(schema, { counts: { nodes: 3 } })).toThrow(/"parentId"/u);
    });

    it("resolves a cycle across tables in a second pass, leaving no dangling id", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            authors: defineTable({ latestBookId: v.id("books") }),
            books: defineTable({ authorId: v.id("authors") }),
        });
        const plan = seedPlan(schema, { counts: { authors: 3, books: 4 } });
        const authorIds = new Set(rowsOf(plan, "authors").map((row) => row._id));
        const bookIds = new Set(rowsOf(plan, "books").map((row) => row._id));

        expect(rowsOf(plan, "authors").every((row) => bookIds.has(row.latestBookId as string))).toBe(true);
        expect(rowsOf(plan, "books").every((row) => authorIds.has(row.authorId as string))).toBe(true);
    });

    it("passes allowOrphans through the seed client", async () => {
        expect.hasAssertions();

        const schema = defineSchema({ nodes: defineTable({ parentId: v.id("nodes") }) });

        type Model = { nodes: { parentId: string } };

        await expect(createSeedClient<Model>(schema).nodes(1)).rejects.toThrow(/"parentId"/u);
        await expect(createSeedClient<Model>(schema, { allowOrphans: true }).nodes(1)).resolves.toHaveProperty("nodes");
    });

    it("points a required self-reference at existing rows when the table already has some", () => {
        expect.hasAssertions();

        const schema = defineSchema({ nodes: defineTable({ parentId: v.id("nodes") }) });
        const rows = rowsOf(seedPlan(schema, { counts: { nodes: 3 }, existingIds: { nodes: ["root"] } }), "nodes");
        const known = new Set(["root", ...rows.map((row) => row._id)]);

        expect(rows.every((row) => known.has(row.parentId as string))).toBe(true);
    });

    it("refuses a cycle whose other side seeds no rows, rather than leaving the id dangling", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            authors: defineTable({ latestBookId: v.id("books") }),
            books: defineTable({ authorId: v.id("authors") }),
        });

        expect(() => seedPlan(schema, { counts: { authors: 2, books: 0 } })).toThrow(/"latestBookId"/u);
    });

    describe.each([
        ["authors first", true],
        ["books first", false],
    ])("a unique FK on a cycle edge, %s", (_label, authorsFirst) => {
        const authors = defineTable({ latestBookId: v.id("books").unique() });
        const books = defineTable({ authorId: v.id("authors") });
        const schema = defineSchema(authorsFirst ? { authors, books } : { books, authors });

        it("is dealt distinct values that all point at real rows", () => {
            expect.hasAssertions();

            const plan = seedPlan(schema, { counts: { authors: 3, books: 3 } });
            const bookIds = new Set(rowsOf(plan, "books").map((row) => row._id));
            const latest = rowsOf(plan, "authors").map((row) => row.latestBookId as string);

            expect(new Set(latest).size).toBe(3);
            expect(latest.every((id) => bookIds.has(id))).toBe(true);
        });

        it("is refused past its parent's row count, naming the column", () => {
            expect.hasAssertions();

            expect(() => seedPlan(schema, { counts: { authors: 3, books: 2 } })).toThrow(/"latestBookId" has only 2/u);
        });
    });

    it("plans a unique cycle-edge FK against the parent's completed pool, not only its existing ids", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            authors: defineTable({ latestBookId: v.id("books").unique() }),
            books: defineTable({ authorId: v.id("authors") }),
        });
        const plan = seedPlan(schema, { counts: { authors: 2, books: 3 }, existingIds: { books: ["b-old"] } });
        const latest = rowsOf(plan, "authors").map((row) => row.latestBookId as string);
        const bookIds = new Set(["b-old", ...rowsOf(plan, "books").map((row) => row._id as string)]);

        expect(new Set(latest).size).toBe(2);
        expect(latest.every((id) => bookIds.has(id))).toBe(true);
    });

    describe("a composite unique index on a table hanging off a cycle", () => {
        const a = defineTable({ bId: v.id("b") });
        const b = defineTable({ aId: v.id("a") });
        const c = defineTable({ aId: v.id("a"), bId: v.id("b") }).index("by_a_b", ["aId", "bId"], { unique: true });
        const counts = { a: 2, b: 2, c: 4 };
        const childFirst = seedPlan(defineSchema({ c, a, b }), { counts });
        const parentsFirst = seedPlan(defineSchema({ a, b, c }), { counts });

        it.each([
            ["declared before the cycle", childFirst],
            ["declared after the cycle", parentsFirst],
        ])("is dealt distinct pairs when %s", (_label, plan) => {
            expect.hasAssertions();

            const pairs = new Set(rowsOf(plan, "c").map((row) => `${row.aId as string}|${row.bId as string}`));

            expect(pairs.size).toBe(4);
        });

        it("does not depend on declaration order", () => {
            expect.hasAssertions();

            expect(rowsOf(childFirst, "c")).toStrictEqual(rowsOf(parentsFirst, "c"));
        });
    });
});
