import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

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

    it("refuses a unique FK on a cycle edge, which cannot be dealt", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            authors: defineTable({ latestBookId: v.id("books").unique() }),
            books: defineTable({ authorId: v.id("authors") }),
        });

        expect(() => seedPlan(schema, { counts: { authors: 2, books: 2 } })).toThrow(/"latestBookId"/u);
    });
});
