import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import { fromServerSchema, runAdvisor } from "../src";
import unindexedForeignKey from "../src/lints/static/unindexed-foreign-key";

const users = () => defineTable({ name: v.string() });

const run = (schema: ReturnType<typeof defineSchema>) => unindexedForeignKey.run({ schema: fromServerSchema(schema) });

describe("unindexed_foreign_key", () => {
    it("flags a `one`-relation FK column with no index", () => {
        expect.assertions(2);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }).relations((r) => {
                return {
                    author: r.one("users", { field: "authorId" }),
                };
            }),
            users: users(),
        });

        const findings = run(schema);

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            level: "INFO",
            name: "unindexed_foreign_key",
            categories: ["PERFORMANCE"],
            cacheKey: "unindexed_foreign_key:posts:authorId",
            metadata: {
                fkColumn: "authorId",
                table: "posts",
                references: { table: "users", column: "_id" },
                suggestedIndex: { name: "byAuthorId", fields: ["authorId"] },
            },
        });
    });

    it("passes when an index leads with the FK column", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() })
                .index("byAuthorId", ["authorId"])
                .relations((r) => {
                    return { author: r.one("users", { field: "authorId" }) };
                }),
            users: users(),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("passes when the FK is the leading column of a composite index", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), createdAt: v.number() })
                .index("byAuthorCreated", ["authorId", "createdAt"])
                .relations((r) => {
                    return { author: r.one("users", { field: "authorId" }) };
                }),
            users: users(),
        });

        expect(run(schema)).toHaveLength(0);
    });

    it("flags an FK that is only a trailing column (leftmost-prefix rule)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), createdAt: v.number() })
                .index("byCreatedAuthor", ["createdAt", "authorId"])
                .relations((r) => {
                    return { author: r.one("users", { field: "authorId" }) };
                }),
            users: users(),
        });

        expect(run(schema)).toHaveLength(1);
    });

    it("ignores `many` relations (their FK lives on the other table)", () => {
        expect.assertions(1);

        const schema = defineSchema({
            posts: defineTable({ authorId: v.id("users"), title: v.string() }),
            users: users().relations((r) => {
                return { posts: r.many("posts", { field: "authorId" }) };
            }),
        });

        expect(run(schema)).toHaveLength(0);
    });
});

describe("runAdvisor", () => {
    it("runs the static lints and returns their findings", () => {
        expect.assertions(3);

        const schema = fromServerSchema(
            defineSchema({
                posts: defineTable({ authorId: v.id("users") }).relations((r) => {
                    return {
                        author: r.one("users", { field: "authorId" }),
                    };
                }),
                users: users(),
            }),
        );

        expect(runAdvisor({ schema })).toHaveLength(1);
        expect(runAdvisor({ schema }, { source: "runtime" })).toHaveLength(0);
        expect(runAdvisor({ schema }, { source: "static" })).toHaveLength(1);
    });
});
