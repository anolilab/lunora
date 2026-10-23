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

    it("carries a composite on an unbounded member when a zero-capacity string sits beside it", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            cells: defineTable({ code: v.string().max(1), weight: v.number() }).index("by_weight_code", ["weight", "code"], { unique: true }),
        });
        const rows = rowsOf(seedPlan(schema, { counts: { cells: 5 } }), "cells");

        expect(rows.every((row) => (row.code as string).length <= 1)).toBe(true);
        expect(new Set(rows.map((row) => `${String(row.weight)}|${row.code as string}`)).size).toBe(5);
    });

    it("counts a column named twice in an index once", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            flags: defineTable({ flag: v.boolean() }).index("by_flag_flag", ["flag", "flag"], { unique: true }),
        });
        const flags = rowsOf(seedPlan(schema, { counts: { flags: 2 } }), "flags").map((row) => row.flag);

        expect(new Set(flags).size).toBe(2);
        expect(() => seedPlan(schema, { counts: { flags: 3 } })).toThrow(/by_flag_flag/u);
    });

    it("never counts a constant array member towards a composite's capacity", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            flags: defineTable({ on: v.boolean(), tags: v.array(v.string()).max(0) }).index("by_tags_on", ["tags", "on"], { unique: true }),
        });
        const pairs = new Set(rowsOf(seedPlan(schema, { counts: { flags: 2 } }), "flags").map((row) => JSON.stringify([row.tags, row.on])));

        expect(pairs.size).toBe(2);
        expect(() => seedPlan(schema, { counts: { flags: 3 } })).toThrow(/by_tags_on/u);
    });

    it("spreads a through table over several parents when one parent table alone covers the batch", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }),
            users: defineTable({ name: v.string() }),
            likes: defineTable({ postId: v.id("posts"), userId: v.id("users") }).index("by_post_user", ["postId", "userId"], { unique: true }),
        });
        const rows = rowsOf(seedPlan(schema, { counts: { likes: 10, posts: 10, users: 5 } }), "likes");

        expect(new Set(rows.map((row) => row.userId)).size).toBeGreaterThan(1);
        expect(new Set(rows.map((row) => `${row.postId as string}|${row.userId as string}`)).size).toBe(10);

        const both = rowsOf(seedPlan(schema, { counts: { likes: 12, posts: 10, users: 5 } }), "likes");

        expect(new Set(both.map((row) => row.userId)).size).toBe(5);
        expect(new Set(both.map((row) => `${row.postId as string}|${row.userId as string}`)).size).toBe(12);
    });

    it("keeps through-table pairs distinct across calls while the parents are unchanged", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }),
            users: defineTable({ name: v.string() }),
            likes: defineTable({ postId: v.id("posts"), userId: v.id("users") }).index("by_post_user", ["postId", "userId"], { unique: true }),
        });
        const pairsOf = (plan: ReturnType<typeof seedPlan>) => rowsOf(plan, "likes").map((row) => `${row.postId as string}|${row.userId as string}`);

        for (let seed = 0; seed < 10; seed += 1) {
            const first = pairsOf(seedPlan(schema, { counts: { likes: 5, posts: 10, users: 5 }, seed }));
            const second = pairsOf(seedPlan(schema, { counts: { likes: 10, posts: 10, users: 5 }, indexOffset: { likes: 5 }, seed }));

            expect(new Set([...first, ...second]).size).toBe(15);
        }
    });

    it("spreads a foreign key declared after an unbounded string member", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            workspaces: defineTable({ name: v.string() }),
            pages: defineTable({ slug: v.string(), workspaceId: v.id("workspaces") }).index("by_slug_workspace", ["slug", "workspaceId"], { unique: true }),
        });
        const rows = rowsOf(seedPlan(schema, { counts: { pages: 12, workspaces: 3 } }), "pages");

        expect(new Set(rows.map((row) => row.workspaceId)).size).toBe(3);
        expect(new Set(rows.map((row) => `${row.slug as string}|${row.workspaceId as string}`)).size).toBe(12);
    });

    it("leaves a url member and a plain string member of a composite as the generator made them", () => {
        expect.hasAssertions();

        const tables = (indexed: boolean) => {
            const links = defineTable({ label: v.string(), userId: v.id("users"), website: v.string().url() });

            return defineSchema({
                links: indexed ? links.index("by_user_site_label", ["userId", "website", "label"], { unique: true }) : links,
                users: defineTable({ name: v.string() }),
            });
        };
        const options = { counts: { links: 4, users: 4 } };
        const indexed = rowsOf(seedPlan(tables(true), options), "links");
        const plain = rowsOf(seedPlan(tables(false), options), "links");

        expect(indexed.map((row) => [row.website, row.label])).toStrictEqual(plain.map((row) => [row.website, row.label]));
        expect(new Set(indexed.map((row) => row.userId)).size).toBe(4);
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
