import { defineSchema, defineTable } from "@cirrus/server";
import { v } from "@cirrus/values";
import { describe, expect, it } from "vitest";

import { introspectSchema, orderTables } from "../src/introspect";
import type { OverrideContext } from "../src/plan";
import { seedPlan } from "../src/plan";

const schema = defineSchema({
    posts: defineTable({
        authorId: v.id("users"),
        body: v.string(),
        published: v.boolean(),
        title: v.string(),
    }),
    users: defineTable({
        age: v.number(),
        bio: v.optional(v.string()),
        email: v.string(),
        name: v.string(),
        role: v.union(v.literal("admin"), v.literal("member")),
    }),
});

describe("seedPlan", () => {
    it("orders foreign-key parents before children", () => {
        expect.hasAssertions();

        const specs = introspectSchema(schema);
        const order = orderTables(specs, new Set(["posts", "users"]));

        expect(order.indexOf("users")).toBeLessThan(order.indexOf("posts"));
    });

    it("generates the requested row counts with explicit ids", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, { counts: { posts: 7, users: 3 } });
        const users = plan.find((entry) => entry.table === "users")!;
        const posts = plan.find((entry) => entry.table === "posts")!;

        expect(users.rows).toHaveLength(3);
        expect(posts.rows).toHaveLength(7);
        expect(users.rows.every((row) => typeof row._id === "string")).toBe(true);
    });

    it("resolves every FK to a real seeded parent id", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, { counts: { posts: 20, users: 4 } });
        const userIds = new Set(plan.find((entry) => entry.table === "users")!.rows.map((row) => row._id));
        const posts = plan.find((entry) => entry.table === "posts")!.rows;

        expect(posts.every((post) => userIds.has(post.authorId))).toBe(true);
    });

    it("applies field-name heuristics and validator kinds", () => {
        expect.hasAssertions();

        const { rows } = seedPlan(schema, { counts: { users: 5 } }).find((entry) => entry.table === "users")!;
        const user = rows[0]!;

        expect(user.email).toMatch(/@/);
        expect(typeof user.name).toBe("string");
        expect(typeof user.age).toBe("number");
        expect(["admin", "member"]).toContain(user.role);
    });

    it("is deterministic for a given seed and varies across seeds", () => {
        expect.hasAssertions();

        const a = seedPlan(schema, { counts: { posts: 3, users: 2 }, seed: 1 });
        const b = seedPlan(schema, { counts: { posts: 3, users: 2 }, seed: 1 });
        const c = seedPlan(schema, { counts: { posts: 3, users: 2 }, seed: 2 });

        expect(a).toEqual(b);
        expect(a).not.toEqual(c);
    });

    it("honours static and functional overrides", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, {
            counts: { users: 3 },
            overrides: {
                users: {
                    email: (context: OverrideContext) => `user${String(context.index)}@example.com`,
                    name: "Fixed Name",
                },
            },
        });
        const { rows } = plan.find((entry) => entry.table === "users")!;

        expect(rows.map((row) => row.email)).toEqual(["user0@example.com", "user1@example.com", "user2@example.com"]);
        expect(rows.every((row) => row.name === "Fixed Name")).toBe(true);
    });

    it("restricts seeding to `only` tables", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, { defaultCount: 2, only: ["users"] });

        expect(plan).toHaveLength(1);
        expect(plan[0]!.table).toBe("users");
    });

    it("auto-includes FK-parent tables when `only` names just the child", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, { defaultCount: 3, only: ["posts"] });
        const tables = plan.map((entry) => entry.table);

        // `users` is pulled in (posts.authorId → users) and ordered before posts.
        expect(tables).toContain("users");
        expect(tables.indexOf("users")).toBeLessThan(tables.indexOf("posts"));

        const userIds = new Set(plan.find((entry) => entry.table === "users")!.rows.map((row) => row._id));
        const posts = plan.find((entry) => entry.table === "posts")!.rows;

        expect(posts.every((post) => userIds.has(post.authorId))).toBe(true);
    });

    it("connects foreign keys to pre-existing ids without re-seeding the parent", () => {
        expect.hasAssertions();

        const existing = ["user-a", "user-b", "user-c"];
        const plan = seedPlan(schema, { defaultCount: 5, existingIds: { users: existing }, only: ["posts"] });

        // `users` is covered by existingIds, so it is not seeded.
        expect(plan.map((entry) => entry.table)).toEqual(["posts"]);

        const pool = new Set(existing);
        const posts = plan[0]!.rows;

        expect(posts.every((post) => pool.has(post.authorId as string))).toBe(true);
    });

    it("exposes a cross-table `store` to override functions", () => {
        expect.hasAssertions();

        const plan = seedPlan(schema, {
            counts: { posts: 4, users: 2 },
            overrides: {
                posts: {
                    // Copy the title from the parent user the FK points at.
                    title: (context: OverrideContext) => {
                        const users = context.store.users ?? [];
                        const author = users.find((user) => user._id === context.row.authorId);
                        const name = typeof author?.name === "string" ? author.name : "unknown";

                        return `by ${name}`;
                    },
                },
            },
        });
        const users = plan.find((entry) => entry.table === "users")!.rows;
        const posts = plan.find((entry) => entry.table === "posts")!.rows;
        const names = new Set(users.map((user) => `by ${String(user.name)}`));

        expect(posts.every((post) => names.has(post.title as string))).toBe(true);
    });
});
