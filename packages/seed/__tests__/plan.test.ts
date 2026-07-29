import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
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

    it("re-seeds a parent when existingIds entry is present but empty (regression: empty array must not be treated as covered)", () => {
        // An empty existingIds array means the caller found no existing rows — the
        // planner must still seed the parent so child FKs resolve to real ids.
        expect.hasAssertions();

        const plan = seedPlan(schema, { defaultCount: 3, existingIds: { users: [] }, only: ["posts"] });
        const tables = plan.map((entry) => entry.table);

        expect(tables).toContain("users");

        const userIds = new Set(plan.find((entry) => entry.table === "users")!.rows.map((row) => row._id));
        const posts = plan.find((entry) => entry.table === "posts")!.rows;

        expect(posts.every((post) => userIds.has(post.authorId))).toBe(true);
    });

    it("resolves a self-referencing FK to earlier rows and leaves the first row's parent empty", () => {
        // A `v.id(self)` column may only point at a row generated earlier in the
        // same table, so the first row has no parent (null, because the column is
        // nullable) and every later row references an already-emitted id.
        expect.hasAssertions();

        const selfRef = defineSchema({
            nodes: defineTable({ name: v.string(), parentId: v.id("nodes").nullable() }),
        });

        const { rows } = seedPlan(selfRef, { counts: { nodes: 6 } }).find((entry) => entry.table === "nodes")!;
        const ids = rows.map((row) => row._id as string);

        // First row can have no earlier parent — a nullable self-FK becomes null.
        expect(rows[0]!.parentId).toBeNull();

        // Every later parentId points at a row emitted before it (no forward refs,
        // no dangling ids), which is what keeps a self-referencing insert valid.
        for (let index = 1; index < rows.length; index += 1) {
            const { parentId } = rows[index]!;
            // A null parent (nullable column, no chosen parent) is valid; a non-null
            // one must reference an earlier row.
            const earlierIds = parentId === null ? [parentId] : ids.slice(0, index);

            expect(earlierIds).toContain(parentId);
        }
    });

    it("terminates and seeds both tables on a cross-table FK cycle", () => {
        // a.bId → b and b.aId → a form a cycle; topological ordering can't satisfy
        // both, so the planner must break the cycle (emit declaration order) rather
        // than loop forever, and still produce a row set for each table.
        expect.hasAssertions();

        const cyclic = defineSchema({
            a: defineTable({ bId: v.id("b"), name: v.string() }),
            b: defineTable({ aId: v.id("a"), name: v.string() }),
        });

        const order = orderTables(introspectSchema(cyclic), new Set(["a", "b"]));

        expect(order).toHaveLength(2);
        expect(new Set(order)).toEqual(new Set(["a", "b"]));

        const plan = seedPlan(cyclic, { counts: { a: 3, b: 3 } });

        expect(new Set(plan.map((entry) => entry.table))).toEqual(new Set(["a", "b"]));
        expect(plan.every((entry) => entry.rows.length === 3)).toBe(true);
    });

    it("never collides ids across batches separated by indexOffset", () => {
        // A client seeding the same table across calls passes the running total as
        // indexOffset; each id hashes from the absolute index, so the two batches
        // must be disjoint.
        expect.hasAssertions();

        const first = seedPlan(schema, { counts: { users: 4 } }).find((entry) => entry.table === "users")!;
        const second = seedPlan(schema, { counts: { users: 4 }, indexOffset: { users: 4 } }).find((entry) => entry.table === "users")!;

        const firstIds = new Set(first.rows.map((row) => row._id));
        const secondIds = second.rows.map((row) => row._id as string);

        expect(secondIds.some((id) => firstIds.has(id))).toBe(false);
    });

    it("throws on an unknown table name in `only` (regression: was a silent empty plan)", () => {
        expect.hasAssertions();

        expect(() => seedPlan(schema, { only: ["userz"] })).toThrow(/unknown table/iu);
    });

    it("does not seed a grandparent reached only through an existingIds-covered parent", () => {
        // comments → posts → users. Seeding just `comments` with `posts` covered by
        // existingIds must not pull in `users`: nothing being seeded references it.
        expect.hasAssertions();

        const chain = defineSchema({
            comments: defineTable({ body: v.string(), postId: v.id("posts") }),
            posts: defineTable({ authorId: v.id("users"), title: v.string() }),
            users: defineTable({ name: v.string() }),
        });

        const plan = seedPlan(chain, { defaultCount: 4, existingIds: { posts: ["p1", "p2"] }, only: ["comments"] });
        const tables = plan.map((entry) => entry.table);

        expect(tables).toEqual(["comments"]);
        expect(tables).not.toContain("users");

        const pool = new Set(["p1", "p2"]);

        expect(plan[0]!.rows.every((row) => pool.has(row.postId as string))).toBe(true);
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

describe("seedPlan — reproducibility", () => {
    const eventsSchema = defineSchema({
        events: defineTable({ createdAt: v.number(), name: v.string() }),
    });

    it("is byte-identical for the same (seed, now) pair", () => {
        expect.assertions(1);

        // The determinism the package promises: same seed AND same clock
        // reference yields the same rows, which is what makes a seeded
        // screenshot or a bug report replayable.
        const first = seedPlan(eventsSchema, { defaultCount: 5, now: 1_785_000_000_000, seed: 7 });
        const second = seedPlan(eventsSchema, { defaultCount: 5, now: 1_785_000_000_000, seed: 7 });

        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });

    it("moves time-valued columns when only `now` changes", () => {
        expect.assertions(1);

        // `now` is the one input that is not covered by `seed`; a caller that
        // forgets it would silently lose reproducibility, which is why
        // `generateValue` takes it with no default.
        const early = seedPlan(eventsSchema, { defaultCount: 5, now: 1_700_000_000_000, seed: 7 });
        const late = seedPlan(eventsSchema, { defaultCount: 5, now: 1_785_000_000_000, seed: 7 });

        expect(JSON.stringify(late)).not.toBe(JSON.stringify(early));
    });
});
