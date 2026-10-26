import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedPlan } from "../src/plan";

const schema = defineSchema({
    comments: defineTable({
        authorId: v.id("users"),
        parentId: v.optional(v.id("comments")),
    }),
    users: defineTable({ name: v.string() }),
});

describe("seedPlan — foreign-key pools", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("resolves every author to one of the seeded users", () => {
        expect.hasAssertions();

        // Each column's candidates are built once and read by position, so every draw must land on a real parent.
        const counts = { comments: 20, users: 5 };
        const userIds = new Set(
            seedPlan(schema, { counts, now: 0 })
                .find((entry) => entry.table === "users")!
                .rows.map((row) => row._id),
        );
        const comments = seedPlan(schema, { counts, now: 0 }).find((entry) => entry.table === "comments")!.rows;

        expect(comments.every((row) => userIds.has(row.authorId))).toBe(true);
    });

    it("points a self-reference only at earlier rows or pre-existing ids", () => {
        expect.hasAssertions();

        const existing = ["old-1", "old-2"];
        const [comments] = seedPlan(schema, { counts: { comments: 30 }, existingIds: { comments: existing, users: ["u1"] }, now: 0, only: ["comments"] });
        const seen = new Set(existing);

        const dangling: unknown[] = [];

        for (const row of comments!.rows) {
            if (row.parentId !== undefined && !seen.has(row.parentId as string)) {
                dangling.push(row.parentId);
            }

            seen.add(row._id as string);
        }

        expect(dangling).toStrictEqual([]);
    });

    it("is reproducible", () => {
        expect.hasAssertions();

        const options = { counts: { comments: 25, users: 4 }, now: 0, seed: 3 };

        expect(seedPlan(schema, options)).toStrictEqual(seedPlan(schema, options));
    });
});
