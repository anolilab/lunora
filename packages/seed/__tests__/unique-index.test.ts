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

    it("counts a repeated union literal once when dealing a composite index", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            slots: defineTable({ flag: v.boolean(), kind: v.union(v.literal("x"), v.literal("x")) }).index("by_kind_flag", ["kind", "flag"], { unique: true }),
        });

        expect(() => seedPlan(schema, { counts: { slots: 4 } })).toThrow(/by_kind_flag/u);

        const rows = rowsOf(seedPlan(schema, { counts: { slots: 2 } }), "slots");

        expect(new Set(rows.map((row) => `${row.kind as string}|${String(row.flag)}`)).size).toBe(2);
    });

    it("counts a repeated union literal once for a single unique column", () => {
        expect.hasAssertions();

        const schema = defineSchema({ slots: defineTable({ kind: v.union(v.literal("x"), v.literal("x")).unique() }) });

        expect(() => seedPlan(schema, { counts: { slots: 2 } })).toThrow(/unique column "kind" has only 1 possible values/u);
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

    it("never counts a zero-width decimal range towards a composite's capacity", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            readings: defineTable({ amount: v.number().min(0.5).max(0.5), tags: v.array(v.string()).max(0) }).index("by_amount_tags", ["amount", "tags"], {
                unique: true,
            }),
        });

        expect(rowsOf(seedPlan(schema, { counts: { readings: 1 } }), "readings")).toHaveLength(1);
        expect(() => seedPlan(schema, { counts: { readings: 2 } })).toThrow(/by_amount_tags/u);
    });

    it("counts the exact integers past the safe range towards a composite's capacity", () => {
        expect.hasAssertions();

        // Three exact integers (2^53, 2^53 + 2, 2^53 + 4) times two flags: six distinct pairs.
        const schema = defineSchema({
            ids: defineTable({
                big: v
                    .number()
                    .int()
                    .min(2 ** 53)
                    .max(2 ** 53 + 4),
                flag: v.boolean(),
            }).index("by_big_flag", ["big", "flag"], { unique: true }),
        });
        const rows = rowsOf(seedPlan(schema, { counts: { ids: 6 } }), "ids");

        expect(new Set(rows.map((row) => `${String(row.big)}|${String(row.flag)}`)).size).toBe(6);
        expect(() => seedPlan(schema, { counts: { ids: 7 } })).toThrow(/by_big_flag/u);
    });

    it("counts a parent id once however often existingIds lists it", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            users: defineTable({ name: v.string() }),
            links: defineTable({ kind: v.number().min(1).max(1), userId: v.id("users") }).index("by_user_kind", ["userId", "kind"], { unique: true }),
        });
        const options = { existingIds: { users: ["u-1", "u-1", "u-2"] }, only: ["links"] };

        expect(new Set(rowsOf(seedPlan(schema, { ...options, counts: { links: 2 } }), "links").map((row) => row.userId)).size).toBe(2);
        expect(() => seedPlan(schema, { ...options, counts: { links: 3 } })).toThrow(/by_user_kind/u);
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

    it("seeds past the counted members when a hash-derived member keeps the rows apart", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            files: defineTable({ file: v.storage(), kind: v.union(v.literal("a"), v.literal("b")) }).index("by_file_kind", ["file", "kind"], { unique: true }),
            links: defineTable({ left: v.string().url(), right: v.string().url() }).index("by_left_right", ["left", "right"], { unique: true }),
            sites: defineTable({ isPrimary: v.boolean(), website: v.string().url() }).index("by_site_primary", ["website", "isPrimary"], { unique: true }),
        });
        const plan = seedPlan(schema, { counts: { files: 5, links: 5, sites: 5 } });

        expect(new Set(rowsOf(plan, "sites").map((row) => `${String(row.website)}|${String(row.isPrimary)}`)).size).toBe(5);
        expect(new Set(rowsOf(plan, "links").map((row) => `${String(row.left)}|${String(row.right)}`)).size).toBe(5);
        expect(new Set(rowsOf(plan, "files").map((row) => `${String(row.file)}|${String(row.kind)}`)).size).toBe(5);
    });

    it("refuses a second row for a unique array capped at zero items", () => {
        expect.hasAssertions();

        const column = defineSchema({ boxes: defineTable({ tags: v.array(v.string()).max(0).unique() }) });
        const indexed = defineSchema({ boxes: defineTable({ tags: v.array(v.string()).max(0) }).index("by_tags", ["tags"], { unique: true }) });

        expect(rowsOf(seedPlan(column, { counts: { boxes: 1 } }), "boxes")).toHaveLength(1);
        expect(() => seedPlan(column, { counts: { boxes: 2 } })).toThrow(/unique column "tags" has only 1 possible values/u);
        expect(() => seedPlan(indexed, { counts: { boxes: 2 } })).toThrow(/unique column "tags" has only 1 possible values/u);
    });

    it("deals every distinct array a finite element domain allows, and no more", () => {
        expect.hasAssertions();

        const schema = defineSchema({ boxes: defineTable({ bits: v.array(v.boolean()).max(2).unique() }) });
        const bits = rowsOf(seedPlan(schema, { counts: { boxes: 7 } }), "boxes").map((row) => JSON.stringify(row.bits));

        expect(new Set(bits).size).toBe(7);
        expect(() => seedPlan(schema, { counts: { boxes: 8 } })).toThrow(/unique column "bits" has only 7 possible values/u);

        const open = defineSchema({ boxes: defineTable({ bits: v.array(v.boolean()).unique() }) });
        const openBits = rowsOf(seedPlan(open, { counts: { boxes: 40 } }), "boxes").map((row) => JSON.stringify(row.bits));

        expect(new Set(openBits).size).toBe(40);

        const lengths = defineSchema({ boxes: defineTable({ xs: v.array(v.literal("x")).min(2).max(5).unique() }) });
        const xs = rowsOf(seedPlan(lengths, { counts: { boxes: 4 } }), "boxes").map((row) => (row.xs as string[]).length);

        expect(xs.toSorted((left, right) => left - right)).toStrictEqual([2, 3, 4, 5]);
        expect(() => seedPlan(lengths, { counts: { boxes: 5 } })).toThrow(/has only 4 possible values/u);
    });

    it("counts null as one more element of a nullable array domain", () => {
        expect.hasAssertions();

        const schema = defineSchema({ boxes: defineTable({ xs: v.array(v.literal("x").nullable()).max(1).unique() }) });
        const xs = rowsOf(seedPlan(schema, { counts: { boxes: 3 } }), "boxes").map((row) => JSON.stringify(row.xs));

        expect(new Set(xs).size).toBe(3);
        expect(xs).toContain("[null]");
        expect(() => seedPlan(schema, { counts: { boxes: 4 } })).toThrow(/unique column "xs" has only 3 possible values/u);
    });

    it("seeds the empty array for a unique column whose element domain admits nothing", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            boxes: defineTable({
                xs: v
                    .array(v.literal("x").check(() => false))
                    .max(1)
                    .unique(),
            }),
        });
        const xs = rowsOf(seedPlan(schema, { counts: { boxes: 1 } }), "boxes").map((row) => row.xs);

        expect(xs).toStrictEqual([[]]);
        expect(() => seedPlan(schema, { counts: { boxes: 2 } })).toThrow(/unique column "xs" has only 1 possible values/u);

        const required = defineSchema({
            boxes: defineTable({
                xs: v
                    .array(v.literal("x").check(() => false))
                    .min(1)
                    .max(1)
                    .unique(),
            }),
        });

        expect(() => seedPlan(required, { counts: { boxes: 1 } })).toThrow(/unique column "xs" has only 0 possible values/u);
    });

    it("deals only the arrays an array-level refinement on the column accepts", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            boxes: defineTable({
                xs: v
                    .array(v.literal("x"))
                    .max(2)
                    .check((xs) => xs.length === 2)
                    .unique(),
            }),
        });
        const xs = rowsOf(seedPlan(schema, { counts: { boxes: 1 } }), "boxes").map((row) => row.xs);

        expect(xs).toStrictEqual([["x", "x"]]);
        expect(() => seedPlan(schema, { counts: { boxes: 2 } })).toThrow(/unique column "xs" has only 1 possible values/u);
    });

    it("counts NULL as one more value of a nullable unique array", () => {
        expect.hasAssertions();

        const schema = defineSchema({ boxes: defineTable({ tags: v.array(v.string()).max(0).nullable().unique() }) });
        const tags = rowsOf(seedPlan(schema, { counts: { boxes: 2 } }), "boxes").map((row) => JSON.stringify(row.tags));

        expect(tags.toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["[]", "null"]);
        expect(() => seedPlan(schema, { counts: { boxes: 3 } })).toThrow(/unique column "tags" has only 2 possible values/u);
    });

    it("refuses a refined array column too large to list, rather than seed a value it rejects", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            boxes: defineTable({
                bits: v
                    .array(v.boolean())
                    .max(50)
                    .check((bits) => bits.length === 2)
                    .unique(),
            }),
        });

        expect(() => seedPlan(schema, { counts: { boxes: 1 } })).toThrow(/cannot generate unique values for "boxes"\."bits"/u);
    });

    it("takes NULL for the rows past a nullable member's finite ceiling, which a unique index never compares", () => {
        expect.hasAssertions();

        const unionNull = defineSchema({
            slots: defineTable({ flag: v.boolean(), kind: v.union(v.literal("x"), v.null()) }).index("by_kind_flag", ["kind", "flag"], { unique: true }),
        });
        const nullable = defineSchema({
            slots: defineTable({ flag: v.boolean(), kind: v.literal("x").nullable() }).index("by_kind_flag", ["kind", "flag"], { unique: true }),
        });

        for (const schema of [unionNull, nullable]) {
            const rows = rowsOf(seedPlan(schema, { counts: { slots: 10 } }), "slots");
            const live = rows.filter((row) => row.kind !== null).map((row) => `${row.kind as string}|${String(row.flag)}`);

            expect(rows).toHaveLength(10);
            expect(new Set(live).size).toBe(live.length);
            expect(live).toContain("x|true");
            expect(live).toContain("x|false");
        }
    });

    it("counts the arrays a finite element domain can form towards a composite's capacity", () => {
        expect.hasAssertions();

        const capped = defineSchema({
            flags: defineTable({ on: v.boolean(), tags: v.array(v.literal("x")).max(1) }).index("by_tags_on", ["tags", "on"], { unique: true }),
        });
        const pairs = new Set(rowsOf(seedPlan(capped, { counts: { flags: 4 } }), "flags").map((row) => JSON.stringify([row.tags, row.on])));

        expect(pairs.size).toBe(4);
        expect(() => seedPlan(capped, { counts: { flags: 5 } })).toThrow(/by_tags_on/u);

        const exact = defineSchema({
            flags: defineTable({ on: v.boolean(), tags: v.array(v.literal("x")).min(1).max(1) }).index("by_tags_on", ["tags", "on"], { unique: true }),
        });

        expect(() => seedPlan(exact, { counts: { flags: 3 } })).toThrow(/by_tags_on/u);
    });

    it("refuses a url column covered by a single-column unique index, as .unique() does", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            links: defineTable({ website: v.string().url() }).index("by_website", ["website"], { unique: true }),
        });

        expect(() => seedPlan(schema, { counts: { links: 5 } })).toThrow(/format "uri"/u);

        const supplied = seedPlan(schema, {
            counts: { links: 5 },
            overrides: { links: { website: ({ index }: { index: number }) => `https://example.com/${String(index)}` } },
        });

        expect(new Set(rowsOf(supplied, "links").map((row) => row.website)).size).toBe(5);
    });

    it("checks a later index that shares a column an earlier index dealt", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            flags: defineTable({ a: v.boolean(), b: v.boolean(), c: v.literal("k") })
                .index("by_a_b", ["a", "b"], { unique: true })
                .index("by_a_c", ["a", "c"], { unique: true }),
        });

        expect(rowsOf(seedPlan(schema, { counts: { flags: 2 } }), "flags")).toHaveLength(2);
        expect(() => seedPlan(schema, { counts: { flags: 3 } })).toThrow(/by_a_c/u);
    });

    it("lets a later index that contains every column of an earlier one reuse its deal", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            flags: defineTable({ a: v.boolean(), b: v.boolean(), c: v.literal("k") })
                .index("by_a_b", ["a", "b"], { unique: true })
                .index("by_a_b_c", ["a", "b", "c"], { unique: true }),
        });
        const rows = rowsOf(seedPlan(schema, { counts: { flags: 4 } }), "flags");

        expect(new Set(rows.map((row) => `${String(row.a)}|${String(row.b)}`)).size).toBe(4);
    });

    it("deals a composite member whose override defers, so a bounded pair cannot repeat", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            slots: defineTable({ kind: v.union(v.literal("a"), v.literal("b")), status: v.union(v.literal("x"), v.literal("y")) }).index(
                "by_kind_status",
                ["kind", "status"],
                { unique: true },
            ),
        });
        const overrides = { slots: { status: () => undefined } };
        const pairs = new Set(rowsOf(seedPlan(schema, { counts: { slots: 4 }, overrides }), "slots").map((row) => `${String(row.kind)}|${String(row.status)}`));

        expect(pairs.size).toBe(4);
        expect(() => seedPlan(schema, { counts: { slots: 5 }, overrides })).toThrow(/by_kind_status/u);
    });

    it("keeps the value a composite member's override supplies", () => {
        expect.hasAssertions();

        const schema = defineSchema({
            slots: defineTable({ kind: v.union(v.literal("a"), v.literal("b")), status: v.union(v.literal("x"), v.literal("y")) }).index(
                "by_kind_status",
                ["kind", "status"],
                { unique: true },
            ),
        });
        const overrides = { slots: { status: ({ index }: { index: number }) => (index === 0 ? "y" : undefined) } };

        expect(rowsOf(seedPlan(schema, { counts: { slots: 4 }, overrides }), "slots")[0]).toMatchObject({ status: "y" });
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
