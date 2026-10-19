import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { afterEach, describe, expect, it, vi } from "vitest";

import { copycat } from "../src/copycat";
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

    it("builds each column's pool once, not once per row", () => {
        expect.hasAssertions();

        const spy = vi.spyOn(copycat, "oneOf");

        seedPlan(schema, { counts: { comments: 20, users: 5 }, now: 0 });

        const authorPools = new Set(spy.mock.calls.map(([, pool]) => pool).filter((pool) => pool.length === 5));

        // Every `authorId` draw reads the same array instance.
        expect(authorPools.size).toBe(1);

        // The self-reference grows one array in place (so it is also one instance across rows).
        const selfPools = new Set(spy.mock.calls.map(([, pool]) => pool).filter((pool) => pool !== [...authorPools][0]));

        expect(selfPools.size).toBe(1);
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
