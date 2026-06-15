import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { circularFk, fromServerSchema } from "../src";

const run = (schema: ReturnType<typeof defineSchema>) => circularFk.run({ schema: fromServerSchema(schema) });

describe("circular_fk", () => {
    it("detects a direct two-table cycle (A → B → A)", () => {
        expect.assertions(3);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]?.name).toBe("circular_fk");
        // The cycle contains both tables.
        expect(findings[0]?.metadata["tables"]).toEqual(expect.arrayContaining(["comments", "posts"]));
    });

    it("detects a three-table cycle (A → B → C → A)", () => {
        expect.assertions(2);

        const schema = defineSchema({
            // a.bId → b, b.cId → c, c.aId → a
            a: defineTable({ bId: v.id("b") }).relations((r) => {
                return { b: r.one("b", { field: "bId" }) };
            }),
            b: defineTable({ cId: v.id("c") }).relations((r) => {
                return { c: r.one("c", { field: "cId" }) };
            }),
            c: defineTable({ aId: v.id("a") }).relations((r) => {
                return { a: r.one("a", { field: "aId" }) };
            }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect((findings[0]?.metadata["cycle"] as string[]).toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b", "c"]);
    });

    it("reports each cycle exactly once (idempotent under any DFS entry order)", () => {
        expect.assertions(1);

        // The same two-table cycle is reachable from both tables — must not double-report.
        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(1);
    });

    it("passes when the schema has no cycles (linear FK chain)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ authorId: v.id("users") }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("ignores `many` relations (they don't own the FK column)", () => {
        expect.assertions(1);

        // users.posts is a `many` back-reference; the FK lives on posts.authorId.
        // Only posts → users is a directed edge; there's no cycle.
        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users") }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes on an empty schema", () => {
        expect.assertions(1);

        expect(circularFk.run({ schema: { tables: [] } })).toHaveLength(0);
    });

    it("finds nothing when no `one` relations are declared", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ title: v.string() }),
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("populates cacheKey, detail, and metadata correctly", () => {
        expect.assertions(4);

        const schema = defineSchema({
            comments: defineTable({ postId: v.id("posts") }).relations((r) => {
                return { post: r.one("posts", { field: "postId" }) };
            }),
            posts: defineTable({ commentId: v.id("comments") }).relations((r) => {
                return { comment: r.one("comments", { field: "commentId" }) };
            }),
        });

        const [finding] = run(schema);

        expect(finding?.cacheKey).toMatch(/^circular_fk:/);
        expect(finding?.detail).toContain("Circular foreign-key dependency detected");
        expect(finding?.metadata["path"]).toContain("→");
        expect(Array.isArray(finding?.metadata["cycle"])).toBe(true);
    });
});
