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

describe("seedPlan — unique columns", () => {
    const enumSchema = defineSchema({
        tags: defineTable({
            color: v
                .string()
                .meta({ schema: { enum: ["blue", "green", "red"] } })
                .unique(),
        }),
    });

    it("generates 200 distinct values for unique string columns, deterministically", () => {
        expect.hasAssertions();

        const uniqueSchema = defineSchema({
            accounts: defineTable({
                email: v.string().unique(),
                handle: v.string().unique(),
            }),
        });

        const first = seedPlan(uniqueSchema, { counts: { accounts: 200 }, now: 1_700_000_000_000, seed: 1 });
        const second = seedPlan(uniqueSchema, { counts: { accounts: 200 }, now: 1_700_000_000_000, seed: 1 });
        const { rows } = first.find((entry) => entry.table === "accounts")!;

        expect(new Set(rows.map((row) => row.email)).size).toBe(200);
        expect(new Set(rows.map((row) => row.handle)).size).toBe(200);
        // The email heuristic survives uniquification — still an address shape.
        expect(rows.every((row) => typeof row.email === "string" && row.email.includes("@"))).toBe(true);
        expect(second).toStrictEqual(first);
    });

    it("deals a unique enum column without replacement when the count fits the domain", () => {
        expect.hasAssertions();

        const { rows } = seedPlan(enumSchema, { counts: { tags: 3 }, now: 1_700_000_000_000, seed: 1 }).find((entry) => entry.table === "tags")!;

        expect(new Set(rows.map((row) => row.color))).toStrictEqual(new Set(["blue", "green", "red"]));
    });

    it("fails fast, naming table, column, and counts, when the count exceeds a unique domain", () => {
        expect.hasAssertions();

        const run = (): unknown => seedPlan(enumSchema, { counts: { tags: 10 }, now: 1_700_000_000_000, seed: 1 });

        expect(run).toThrow('unique column "color"');
        expect(run).toThrow(/10 rows into "tags"/);
        expect(run).toThrow(/only 3 possible values/);
    });

    it("refuses a second indexOffset batch the unique domain cannot cover", () => {
        expect.hasAssertions();

        // Values are dealt by ABSOLUTE index, so two batches of 2 over a 3-value
        // domain would wrap index 3 back onto index 0 and duplicate a value.
        const batch = (offset: number): unknown =>
            seedPlan(enumSchema, { counts: { tags: 2 }, indexOffset: { tags: offset }, now: 1_700_000_000_000, seed: 1 });

        expect(batch(0)).toHaveLength(1);
        expect(() => batch(2)).toThrow(/cannot seed 4 rows into "tags"/);
        expect(() => batch(2)).toThrow('unique column "color"');
    });

    it("deals distinct values across indexOffset batches that fit the domain", () => {
        expect.hasAssertions();

        const colorAt = (offset: number): unknown =>
            seedPlan(enumSchema, { counts: { tags: 1 }, indexOffset: { tags: offset }, now: 1_700_000_000_000, seed: 1 }).find(
                (entry) => entry.table === "tags",
            )!.rows[0]!.color;

        expect(new Set([colorAt(0), colorAt(1), colorAt(2)])).toStrictEqual(new Set(["blue", "green", "red"]));
    });

    it("keeps non-unique generation byte-identical (pinned pre-change output)", () => {
        expect.hasAssertions();

        const plainSchema = defineSchema({
            users: defineTable({
                age: v.number(),
                email: v.string(),
                name: v.string(),
            }),
        });

        const { rows } = seedPlan(plainSchema, { counts: { users: 2 }, now: 1_700_000_000_000, seed: 7 }).find((entry) => entry.table === "users")!;

        expect(rows[0]).toStrictEqual({ _id: "d84cf143-978e-4b60-9832-481cdfa76ce2", age: 460, email: "bryan79@hotmail.com", name: "Ada Fritsch DVM" });
        expect(rows[1]).toStrictEqual({ _id: "730f300b-1bf5-4730-9340-429bb785ee9b", age: 509, email: "courtney51@hotmail.com", name: "Griffin Towne" });
    });

    // The tag budget for an email column is the whole fallback domain, not the
    // one-character suffix separator: counting the cheap form let a narrow
    // column claim a billion possible values and then seed one its own
    // validator rejects.
    it("refuses a unique email column too narrow to hold a tagged address", () => {
        expect.hasAssertions();

        const narrow = defineSchema({ people: defineTable({ contact: v.string().email().max(10).unique() }) });
        const run = (): unknown => seedPlan(narrow, { counts: { people: 3 }, now: 1_700_000_000_000, seed: 3 });

        expect(run).toThrow('unique column "contact"');
        expect(run).toThrow(/only 0 possible values/);
    });

    // The narrowest column that can still hold `<tag>@example.com` deals exactly
    // ten values — one per single-digit tag — and no more.
    it("budgets a unique email column's capacity by the domain the tag has to fit around", () => {
        expect.hasAssertions();

        const boundary = defineSchema({ people: defineTable({ contact: v.string().email().max(13).unique() }) });
        const seedRows = (count: number): ReadonlyArray<Record<string, unknown>> =>
            seedPlan(boundary, { counts: { people: count }, now: 1_700_000_000_000, seed: 3 }).find((entry) => entry.table === "people")!.rows;

        const rows = seedRows(10);

        expect(new Set(rows.map((row) => row.contact)).size).toBe(10);
        expect(rows.every((row) => String(row.contact).length <= 13)).toBe(true);
        expect(() => seedRows(11)).toThrow(/cannot seed 11 rows into "people"/);
        expect(() => seedRows(11)).toThrow(/only 10 possible values/);
    });
});

describe("seedPlan — unique columns beyond enums and strings", () => {
    const rowsOf = (shape: Parameters<typeof defineTable>[0], count: number): ReadonlyArray<Record<string, unknown>> =>
        seedPlan(defineSchema({ t: defineTable(shape) }), { counts: { t: count }, now: 1_700_000_000_000, seed: 3 }).find((entry) => entry.table === "t")!.rows;

    const distinct = (rows: ReadonlyArray<Record<string, unknown>>, column: string): number => new Set(rows.map((row) => JSON.stringify(row[column]))).size;

    it("deals a declared numeric range without replacement and stays inside it", () => {
        expect.hasAssertions();

        const rows = rowsOf({ n: v.number().min(1).max(100).unique() }, 100);

        expect(distinct(rows, "n")).toBe(100);
        expect(rows.every((row) => typeof row.n === "number" && row.n >= 1 && row.n <= 100)).toBe(true);
    });

    it("refuses a batch larger than a declared numeric range", () => {
        expect.hasAssertions();

        expect(() => rowsOf({ n: v.number().min(1).max(100).unique() }, 200)).toThrow(/unique column "n" has only 100 possible values/);
    });

    it("keeps unbounded numeric, bigint, temporal, and bytes columns collision-free at scale", () => {
        expect.hasAssertions();

        // None of these declares a domain, so uniqueness has to come from the
        // index rather than from the generator's luck.
        expect(distinct(rowsOf({ n: v.number().unique() }, 2000), "n")).toBe(2000);
        expect(distinct(rowsOf({ b: v.bigint().unique() }, 2000), "b")).toBe(2000);
        expect(distinct(rowsOf({ d: v.date().unique() }, 500), "d")).toBe(500);
        expect(distinct(rowsOf({ y: v.bytes().unique() }, 500), "y")).toBe(500);
    });

    it("refuses a unique literal column past its single possible value", () => {
        expect.hasAssertions();

        // A literal accepts exactly one value, so tagging it per row would emit
        // values the column's own validator rejects.
        expect(rowsOf({ lit: v.literal("same").unique() }, 1)[0]!.lit).toBe("same");
        expect(() => rowsOf({ lit: v.literal("same").unique() }, 2)).toThrow(/unique column "lit" has only 1 possible values/);
    });

    it("keeps unique strings inside maxLength (regression: the index tag was appended after truncation)", () => {
        expect.hasAssertions();

        const rows = rowsOf({ s: v.string().max(16).unique() }, 200);

        expect(rows.every((row) => typeof row.s === "string" && row.s.length <= 16)).toBe(true);
        expect(distinct(rows, "s")).toBe(200);
    });

    it("keeps format-email columns valid addresses even when the name heuristic misses", () => {
        expect.hasAssertions();

        const rows = rowsOf({ contact: v.string().email().unique() }, 50);

        expect(rows.every((row) => /^[^@]+@[^@]+$/.test(String(row.contact)))).toBe(true);
        expect(distinct(rows, "contact")).toBe(50);
    });

    it("keeps a unique format-email column valid once maxLength also bites", () => {
        expect.hasAssertions();

        // The two narrowing steps compose: the generator refits the address into
        // `maxLength`, then the deal reserves room for the index tag inside the
        // same bound. Either step applied blindly emits an address the column's
        // own validator rejects.
        const column = v.string().email().max(24).unique();
        const rows = rowsOf({ contact: column }, 50);

        expect(rows.filter((row) => !column.safeParse(row.contact).ok)).toStrictEqual([]);
        expect(distinct(rows, "contact")).toBe(50);
    });

    it("deals a unique literal union without replacement and refuses past its domain", () => {
        expect.hasAssertions();

        // The same split the `.unique()` FK had: a union of literals is a closed
        // domain, but the generator picked a member per row WITH replacement, so
        // eight rows over two literals simply repeated — the exact case the docs
        // name as refused at plan time.
        const shape = { u: v.union(v.literal("a"), v.literal("b")).unique() };

        expect(new Set(rowsOf(shape, 2).map((row) => row.u))).toStrictEqual(new Set(["a", "b"]));
        expect(() => rowsOf(shape, 8)).toThrow(/unique column "u" has only 2 possible values/);
    });

    it("honours declared bigint bounds on the plain path, not just the unique one", () => {
        expect.hasAssertions();

        // `v.bigint()` drew from its default [0, 1_000_000] whatever the column
        // declared, while the `.unique()` twin walked the declared range — so the
        // plain spelling seeded values the column's own validator rejects.
        const bounded = v.bigint().check(() => true, { schema: { maximum: 5, minimum: 1 } });

        expect(rowsOf({ b: bounded }, 20).every((row) => (row.b as number) >= 1 && (row.b as number) <= 5)).toBe(true);
    });

    it("seeds v.timestamp() and its .unique() twin into the same era", () => {
        expect.hasAssertions();

        // Regression: the plain arm drew from a hard-coded 1980–2020 window while
        // the `.unique()` arm stepped back from `now`, so the two spellings of one
        // column landed four decades apart and the plain one read as long past.
        const now = Date.parse("2026-09-03T00:00:00.000Z");
        const { rows } = seedPlan(defineSchema({ events: defineTable({ expiresAt: v.timestamp(), uniqueAt: v.timestamp().unique() }) }), {
            counts: { events: 20 },
            now,
            seed: 5,
        }).find((entry) => entry.table === "events")!;
        const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;

        expect(rows.every((row) => (row.expiresAt as number) <= now && (row.expiresAt as number) >= now - SIX_MONTHS_MS)).toBe(true);
        expect(rows.every((row) => (row.uniqueAt as number) <= now && (row.uniqueAt as number) >= now - SIX_MONTHS_MS)).toBe(true);
    });

    it("refuses unique columns whose declared shape an index tag would violate", () => {
        expect.hasAssertions();

        expect(() =>
            rowsOf(
                {
                    s: v
                        .string()
                        .pattern(/^[a-z]{3}$/)
                        .unique(),
                },
                5,
            ),
        ).toThrow(/pattern-constrained/);
        expect(() => rowsOf({ s: v.string().url().unique() }, 5)).toThrow(/format "uri"/);
    });
});

describe("seedPlan — unique foreign keys", () => {
    const relationSchema = defineSchema({
        profiles: defineTable({ userId: v.id("users").unique() }),
        users: defineTable({ name: v.string() }),
    });

    it("deals parent ids without replacement for a .unique() foreign key", () => {
        expect.hasAssertions();

        // Regression: `planUniqueDeals` skipped every FK column, so a `.unique()`
        // `v.id("users")` — the natural way to spell a 1:1 — fell through to
        // `copycat.oneOf`, a uniform draw WITH replacement: 7 distinct parents
        // across 10 rows, then a raw UNIQUE-constraint error on insert.
        const plan = seedPlan(relationSchema, { counts: { profiles: 50, users: 50 }, now: 1_700_000_000_000, seed: 1 });
        const userIds = new Set(plan.find((entry) => entry.table === "users")!.rows.map((row) => row._id));
        const linked = plan.find((entry) => entry.table === "profiles")!.rows.map((row) => row.userId);

        expect(new Set(linked).size).toBe(50);
        expect(linked.every((id) => userIds.has(id))).toBe(true);
    });

    it("refuses a batch larger than the parent pool, naming the column", () => {
        expect.hasAssertions();

        const run = (): unknown => seedPlan(relationSchema, { counts: { profiles: 10, users: 4 }, now: 1_700_000_000_000, seed: 1 });

        expect(run).toThrow('unique column "userId"');
        expect(run).toThrow(/only 4 possible values/);
    });

    it("counts pre-existing parent ids toward the pool", () => {
        expect.hasAssertions();

        // The studio's generate-rows dialog seeds one table and passes the live
        // parent ids as `existingIds`, so those have to be part of the domain.
        const { rows } = seedPlan(relationSchema, {
            counts: { profiles: 3 },
            existingIds: { users: ["u1", "u2", "u3"] },
            now: 1_700_000_000_000,
            only: ["profiles"],
            seed: 1,
        }).find((entry) => entry.table === "profiles")!;

        expect(new Set(rows.map((row) => row.userId))).toStrictEqual(new Set(["u1", "u2", "u3"]));
    });

    it("keeps a .unique() self-reference distinct by pointing each row at its predecessor", () => {
        expect.hasAssertions();

        // A self-reference's pool is the rows generated before it, so there is
        // nothing to deal from at plan time; the preceding row is the one choice
        // distinct for every row.
        const { rows } = seedPlan(defineSchema({ nodes: defineTable({ previousId: v.optional(v.id("nodes").unique()) }) }), {
            counts: { nodes: 30 },
            now: 1_700_000_000_000,
            seed: 1,
        }).find((entry) => entry.table === "nodes")!;
        const links = rows.slice(1).map((row) => row.previousId);

        expect(rows[0]!.previousId).toBeUndefined();
        expect(links).toStrictEqual(rows.slice(0, -1).map((row) => row._id));
    });

    it("leaves an ordinary foreign key drawing with replacement", () => {
        expect.hasAssertions();

        // Only `.unique()` changes: a plain `v.id("users")` is a many-to-one and
        // must stay free to repeat a parent.
        const plan = seedPlan(schema, { counts: { posts: 40, users: 3 }, now: 1_700_000_000_000, seed: 1 });

        expect(new Set(plan.find((entry) => entry.table === "posts")!.rows.map((row) => row.authorId)).size).toBeLessThanOrEqual(3);
    });
});
