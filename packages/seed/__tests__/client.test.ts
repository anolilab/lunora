import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import { createSeedClient } from "../src/client";

interface InsertModel {
    posts: { authorId: string; published: boolean; title: string };
    users: { age: number; email: string; name: string };
}

const schema = defineSchema({
    posts: defineTable({
        authorId: v.id("users"),
        published: v.boolean(),
        title: v.string(),
    }),
    users: defineTable({
        age: v.number(),
        email: v.string(),
        name: v.string(),
    }),
});

const client = () => createSeedClient<InsertModel>(schema, { seed: 1 });

describe("createSeedClient", () => {
    it("seeds a table by count and accumulates ids in $store/$ids", async () => {
        expect.hasAssertions();

        const seed = client();
        const { users } = await seed.users(4);

        expect(users).toHaveLength(4);
        expect(seed.$ids.users).toEqual(users);
        expect(seed.$store.users).toHaveLength(4);
        expect(seed.$store.users!.every((row) => typeof row.email === "string")).toBe(true);
    });

    it("connects foreign keys to rows seeded earlier this run", async () => {
        expect.hasAssertions();

        const seed = client();

        await seed.users(3);
        const { posts } = await seed.posts(10);
        const userIds = new Set(seed.$ids.users);

        expect(posts).toHaveLength(10);
        expect(seed.$store.posts!.every((post) => userIds.has(post.authorId as string))).toBe(true);
    });

    it("auto-seeds an FK parent when the child is seeded first", async () => {
        expect.hasAssertions();

        const seed = client();
        const { posts } = await seed.posts(5);

        // `users` is pulled in as a parent so every post FK resolves.
        expect(seed.$ids.users?.length ?? 0).toBeGreaterThan(0);

        const userIds = new Set(seed.$ids.users);

        expect(posts.every((id) => typeof id === "string")).toBe(true);
        expect(seed.$store.posts!.every((post) => userIds.has(post.authorId as string))).toBe(true);
    });

    it("does not collide ids across repeated calls to the same table", async () => {
        expect.hasAssertions();

        const seed = client();

        await seed.users(3);
        await seed.users(3);

        expect(seed.$ids.users).toHaveLength(6);
        expect(new Set(seed.$ids.users).size).toBe(6);
    });

    it("does not re-seed an FK parent that was already seeded explicitly", async () => {
        expect.hasAssertions();

        const seed = client();

        const { users } = await seed.users(3);
        const { posts } = await seed.posts(5);

        // The posts call must connect to the existing users, not regenerate them.
        expect(seed.$ids.users).toEqual(users);
        expect(seed.$store.users).toHaveLength(3);

        const userIds = new Set(users);

        expect(posts).toHaveLength(5);
        expect(seed.$store.posts!.every((post) => userIds.has(post.authorId as string))).toBe(true);
    });

    it("appends rows when an auto-seeded FK parent is later requested explicitly", async () => {
        expect.hasAssertions();

        const seed = client();

        // Seeding posts first auto-pulls `users` as an FK parent.
        await seed.posts(5);
        const autoUsers = [...(seed.$ids.users ?? [])];

        expect(autoUsers.length).toBeGreaterThan(0);

        // Explicitly requesting `users` now must add fresh rows, not be skipped as
        // already-covered, and the new ids must not collide with the auto-seeded run.
        const { users } = await seed.users(3);

        expect(users).toHaveLength(3);
        expect(seed.$ids.users).toHaveLength(autoUsers.length + 3);
        expect(new Set(seed.$ids.users).size).toBe(autoUsers.length + 3);
        expect(autoUsers.every((id) => !users.includes(id))).toBe(true);
    });

    it("applies explicit partial rows, generating omitted fields", async () => {
        expect.hasAssertions();

        const seed = client();

        await seed.users([{ name: "Alice" }, { email: "bob@example.com", name: "Bob" }]);
        const [alice, bob] = seed.$store.users!;

        expect(alice!.name).toBe("Alice");
        // Omitted email is still generated, not undefined.
        expect(typeof alice!.email).toBe("string");
        expect(bob!.name).toBe("Bob");
        expect(bob!.email).toBe("bob@example.com");
    });

    it("honours per-field overrides over partials", async () => {
        expect.hasAssertions();

        const seed = client();

        await seed.users([{ name: "Alice" }], { overrides: { name: (context) => `user-${String(context.index)}` } });

        expect(seed.$store.users![0]!.name).toBe("user-0");
    });

    it("resolves a range spec deterministically", async () => {
        expect.hasAssertions();

        const a = client();
        const b = client();

        const ra = await a.users((x) => x([2, 5]));
        const rb = await b.users([2, 5] as const);

        expect(ra.users.length).toBeGreaterThanOrEqual(2);
        expect(ra.users.length).toBeLessThanOrEqual(5);
        // Same seed + same range ⇒ identical count and ids.
        expect(rb.users).toEqual(ra.users);
    });

    it("persists each batch through the persist hook in FK order", async () => {
        expect.hasAssertions();

        const inserted: { count: number; table: string }[] = [];
        const seed = createSeedClient<InsertModel>(schema, {
            persist: (table, rows) => {
                inserted.push({ count: rows.length, table });
            },
            seed: 2,
        });

        await seed.posts(3);

        // Parent persisted before child.
        expect(inserted.map((entry) => entry.table)).toEqual(["users", "posts"]);
        expect(inserted.find((entry) => entry.table === "posts")!.count).toBe(3);
    });

    it("clears all state on $reset", async () => {
        expect.hasAssertions();

        const seed = client();

        await seed.users(2);
        seed.$reset();

        expect(seed.$ids.users ?? []).toHaveLength(0);
        expect(seed.$store.users ?? []).toHaveLength(0);

        // After reset, ids restart from the original deterministic sequence.
        const fresh = client();
        const fromFresh = await fresh.users(2);

        await seed.users(2);

        expect(seed.$ids.users).toEqual(fromFresh.users);
    });

    it("re-seeds FK parents after $reset (regression: $reset must not leave empty-array tombstones)", async () => {
        // Before the fix, $reset left `idsByTable.users = []` in place. The next
        // posts call passed that empty array as `existingIds.users`, which seedPlan
        // treated as "parent already covered" and skipped user generation — leaving
        // the FK pool empty and generating dangling placeholder ids.
        expect.hasAssertions();

        const seed = client();

        await seed.users(3);
        seed.$reset();

        // After reset, seeding posts must auto-seed users so authorId FKs resolve.
        await seed.posts(5);

        const userIds = new Set(seed.$ids.users);

        expect(userIds.size).toBeGreaterThan(0);
        expect(seed.$store.posts!.every((post) => userIds.has(post.authorId as string))).toBe(true);
    });

    it("serializes overlapping calls through the persist await so deterministic ids never collide (regression: offset race)", async () => {
        // Both calls auto-seed `users` then `posts`. Without serialization, both
        // would read `createdCount.posts === 0` across the persist await and
        // generate byte-identical `_id`s (hashes of the absolute index) — duplicate
        // primary keys. Serialization gives the second call a fresh offset.
        expect.hasAssertions();

        const seed = createSeedClient<InsertModel>(schema, {
            persist: async () => {
                // Yield so an unserialized client would interleave here.
                await Promise.resolve();
            },
            seed: 3,
        });

        const [a, b] = await Promise.all([seed.posts(5), seed.posts(5)]);
        const postIds = [...a.posts, ...b.posts];

        expect(postIds).toHaveLength(10);
        expect(new Set(postIds).size).toBe(10);
        expect(new Set(seed.$ids.posts).size).toBe(seed.$ids.posts?.length ?? 0);
    });

    it("is deterministic for a given seed and varies across seeds", async () => {
        expect.hasAssertions();

        const one = createSeedClient<InsertModel>(schema, { seed: 7 });
        const two = createSeedClient<InsertModel>(schema, { seed: 7 });
        const three = createSeedClient<InsertModel>(schema, { seed: 8 });

        const a = await one.users(3);
        const b = await two.users(3);
        const c = await three.users(3);

        expect(a.users).toEqual(b.users);
        expect(a.users).not.toEqual(c.users);
    });

    // Ids are hashed from `seed` alone, so the determinism the other cases prove
    // survives an unpinned clock. Time-valued columns do not: without `now` they
    // fall back to `Date.now()` per call, and two runs of the same seed differ.
    it("pins time-valued columns to the supplied now", async () => {
        expect.hasAssertions();

        const temporalSchema = defineSchema({ sessions: defineTable({ expiresAt: v.timestamp() }) });
        const rowsAt = async (now: number): Promise<ReadonlyArray<Record<string, unknown>>> => {
            const seed = createSeedClient<{ sessions: { expiresAt: number } }>(temporalSchema, { now, seed: 5 });

            await seed.sessions(3);

            return seed.$store.sessions ?? [];
        };

        const pinned = await rowsAt(1_700_000_000_000);
        const earlier = await rowsAt(1_600_000_000_000);

        expect(pinned).toStrictEqual(await rowsAt(1_700_000_000_000));
        expect(pinned.map((row) => row.expiresAt)).not.toStrictEqual(earlier.map((row) => row.expiresAt));
        expect(pinned.every((row) => typeof row.expiresAt === "number" && row.expiresAt <= 1_700_000_000_000)).toBe(true);
    });
});
