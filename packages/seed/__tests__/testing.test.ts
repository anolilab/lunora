import { defineSchema, defineTable } from "@lunora/server";
import { lunoraTest } from "@lunora/testing";
import { v } from "@lunora/values";
import { afterEach, describe, expect, it } from "vitest";

import { seed } from "../src/testing";

const schema = defineSchema({
    posts: defineTable({
        authorId: v.id("users"),
        title: v.string(),
    }),
    users: defineTable({
        email: v.string(),
        name: v.string(),
    }),
});

describe("seed (testing adapter)", () => {
    let harness: ReturnType<typeof lunoraTest> | undefined;

    afterEach(() => {
        harness?.close();
        harness = undefined;
    });

    it("inserts seeded rows and returns their ids", async () => {
        expect.hasAssertions();

        harness = lunoraTest(schema);
        const ids = await seed(harness, schema, { counts: { posts: 12, users: 4 } });

        expect(ids.users).toHaveLength(4);
        expect(ids.posts).toHaveLength(12);

        const userCount = await harness.run((context) => context.db.query("users").collect());
        const posts = await harness.run((context) => context.db.query("posts").collect());

        expect(userCount).toHaveLength(4);
        expect(posts).toHaveLength(12);

        // Every seeded post points at a real seeded user.
        const userIds = new Set(ids.users);

        expect(posts.every((post) => userIds.has(post.authorId as string))).toBe(true);
    });
});
