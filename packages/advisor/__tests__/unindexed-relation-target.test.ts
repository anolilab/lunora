import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema } from "../src";
import unindexedRelationTarget from "../src/lints/static/unindexed-relation-target";

const run = (schema: ReturnType<typeof defineSchema>) => unindexedRelationTarget.run({ schema: fromServerSchema(schema) });

describe("unindexed_relation_target", () => {
    it("flags a one-directional `many` whose target FK column is unindexed", () => {
        expect.assertions(2);

        // `posts` carries `authorId` but declares no inverse `one` relation and
        // no index — so `unindexed_foreign_key` never sees it. This lint does.
        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            categories: ["PERFORMANCE"],
            cacheKey: "unindexed_relation_target:posts:authorId",
            level: "INFO",
            metadata: {
                fkColumn: "authorId",
                references: { column: "_id", table: "users" },
                relation: "posts",
                suggestedIndex: { fields: ["authorId"], name: "byAuthorId" },
                table: "posts",
            },
            name: "unindexed_relation_target",
        });
    });

    it("passes when the target FK column leads an index", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }).index("byAuthorId", ["authorId"]),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes (no double-report) when the target declares the inverse `one` relation", () => {
        expect.assertions(1);

        // Bidirectional: `posts.author` is a `one` on `authorId`, so
        // `unindexed_foreign_key` owns this finding — we stay silent.
        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("ignores `one` relations (their FK lives on the holder — `unindexed_foreign_key`'s job)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => {
                return { author: r.one("users", { field: "authorId" }) };
            }),
            users: defineTable({ name: v.string() }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes when the target FK leads a composite index (leftmost-prefix rule)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), createdAt: v.number() }).index("byAuthorCreated", ["authorId", "createdAt"]),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("flags a target FK that is only a trailing index column", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), createdAt: v.number() }).index("byCreatedAuthor", ["createdAt", "authorId"]),
            users: defineTable({ name: v.string() }).relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(1);
    });
});
