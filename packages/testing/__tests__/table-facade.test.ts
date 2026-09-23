/**
 * Regression tests for issue #797: `ctx.db.<table>` — the per-table ORM facade
 * (`ctx.db.notes.findMany(...)`) — must exist on the harness ctx, with and
 * without `.use(rls(...))`, and must route through the policies when it is
 * there.
 *
 * The harness builds its own ctx rather than running codegen's generated
 * `buildCtx`, and it used to skip the facade glue that `buildCtx` emits: every
 * `ctx.db.<table>` read answered `undefined` here while working in production
 * ("TypeError: Cannot read properties of undefined (reading 'findMany')"). The
 * `rls()` middleware re-binds the facade entries it finds on the writer it
 * wraps, so with none on the writer there was nothing to re-bind either.
 *
 * These tests dispatch through the REAL procedure builder and the REAL
 * `createShardCtxDb` writer — not a hand-built double — because a double glues
 * its own facade and would pass either way.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, rls, v } from "@lunora/server";
import { describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";

const { mutation, query } = initLunora.dataModel().create();

/**
 * Deliberately NOT `.rls("required")` — issue #797 reports the loss on a plain
 * schema with `rls()` applied per procedure. `other` carries no policy at all,
 * so it also pins that a non-policy table keeps its facade.
 */
const schema = defineSchema({
    notes: defineTable({ body: v.string(), userId: v.string() }).index("by_user", ["userId"]),
    other: defineTable({ label: v.string() }),
});

/** Same permissive cast `rls-enforcement.test.ts` pins: the raw builder types `ctx.db` nominally. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const policies = definePolicies([
    definePolicy({
        on: "read",
        table: "notes",
        when: ({ auth }: { auth: { userId: null | string } }) => {
            return { userId: auth.userId ?? "" };
        },
    }),
    definePolicy({
        on: "insert",
        table: "notes",
        when: ({ auth, row }: { auth: { userId: null | string }; row?: Record<string, unknown> }) => row?.["userId"] === auth.userId,
    }),
]);

/**
 * The facade detector the RLS middleware itself uses (`isFacadeEntry`): an own
 * property carrying the `findMany` + `withSearchIndex` pair. Reading the key set
 * off the live object is the point — a test naming `notes` would pass while
 * every other table stayed broken.
 */
const facadeTables = (database: unknown): string[] =>
    Object.entries(database as Record<string, unknown>)
        .filter(([, value]) => {
            if (typeof value !== "object" || value === null) {
                return false;
            }

            const candidate = value as Record<string, unknown>;

            return typeof candidate["findMany"] === "function" && typeof candidate["withSearchIndex"] === "function";
        })
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b));

/**
 * The secure-by-default twin: under `.rls("required")` the facade is bound over
 * the GUARDED writer, so a facade read with no `rls()` in the chain must be
 * denied — restoring the accessors must not open a hole the flat form closes.
 */
const guardedSchema = defineSchema({
    notes: defineTable({ body: v.string(), userId: v.string() }),
}).rls("required");

const unguardedFacadeRead = query.query(async ({ ctx }) => ((await (ctx.db as any).notes.findMany({})) as { page: unknown[] }).page.length);

const seed = mutation.mutation(async ({ ctx }) => {
    await ctx.db.insert("notes", { body: "mine", userId: "u1" });
    await ctx.db.insert("notes", { body: "theirs", userId: "u2" });
    await ctx.db.insert("other", { label: "unpoliced" });
});

const plainTables = query.query(({ ctx }) => facadeTables(ctx.db));
const guardedTables = query.use(rlsForTest(policies)).query(({ ctx }) => facadeTables(ctx.db));

const plainBodies = query.query(async ({ ctx }) => ((await (ctx.db as any).notes.findMany({})) as { page: { body: string }[] }).page.map((row) => row.body));

const guardedBodies = query
    .use(rlsForTest(policies))
    .query(async ({ ctx }) => ((await ctx.db.notes.findMany({})) as { page: { body: string }[] }).page.map((row) => row.body));

const guardedFindFirst = query
    .use(rlsForTest(policies))
    .input({ body: v.string() })
    .query(async ({ args, ctx }) => (await ctx.db.notes.findFirst({ where: { body: args.body } })) as null | Record<string, unknown>);

const guardedCountOther = query.use(rlsForTest(policies)).query(async ({ ctx }) => (await ctx.db.other.count()) as number);

const guardedInsert = mutation
    .use(rlsForTest(policies))
    .input({ userId: v.string() })
    .mutation(async ({ args, ctx }) => (await ctx.db.notes.insert({ body: "written", userId: args.userId })) as string);

describe("issue #797 — ctx.db.<table> facades under rls()", () => {
    it("exposes the per-table facade without rls()", async () => {
        expect.assertions(2);

        const t = lunoraTest(schema);

        await t.mutation(seed, {});

        await expect(t.query(plainTables, {})).resolves.toStrictEqual(["notes", "other"]);
        await expect(t.query(plainBodies, {}).then((bodies) => bodies.toSorted((a, b) => a.localeCompare(b)))).resolves.toStrictEqual(["mine", "theirs"]);
    });

    it("keeps every facade the un-wrapped ctx.db exposes after rls() wraps it", async () => {
        expect.assertions(2);

        const t = lunoraTest(schema);
        const before = await t.query(plainTables, {});
        const after = await t.withIdentity({ userId: "u1" }).query(guardedTables, {});

        // Derived from the live writer on both sides — no hardcoded table list.
        expect(before.length).toBeGreaterThan(0);
        expect(after).toStrictEqual(before);
    });

    it("reads through the facade are policy-filtered, not merely restored", async () => {
        expect.assertions(3);

        const t = lunoraTest(schema);

        await t.mutation(seed, {});

        const ada = t.withIdentity({ userId: "u1" });

        // Only the caller's own row — the unfiltered read returns both.
        await expect(ada.query(guardedBodies, {})).resolves.toStrictEqual(["mine"]);
        // A targeted lookup of another user's row must not resolve it either.
        await expect(ada.query(guardedFindFirst, { body: "theirs" })).resolves.toBeNull();
        await expect(ada.query(guardedFindFirst, { body: "mine" })).resolves.toMatchObject({ userId: "u1" });
    });

    it("writes through the facade are gated by the insert policy", async () => {
        expect.assertions(2);

        const t = lunoraTest(schema);
        const ada = t.withIdentity({ userId: "u1" });

        await expect(ada.mutation(guardedInsert, { userId: "u1" })).resolves.toBeTypeOf("string");
        // Writing a row the policy does not own is denied, not silently accepted.
        await expect(ada.mutation(guardedInsert, { userId: "u2" })).rejects.toThrow(/FORBIDDEN|policy/i);
    });

    it("a table with no policy keeps a working facade", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema);

        await t.mutation(seed, {});

        await expect(t.withIdentity({ userId: "u1" }).query(guardedCountOther, {})).resolves.toBe(1);
    });

    it("the trusted t.run writer carries the facade too", async () => {
        expect.assertions(1);

        const t = lunoraTest(schema);

        await t.mutation(seed, {});

        await expect(t.run(async (ctx) => ((await (ctx.db as any).notes.findMany({})) as { page: unknown[] }).page.length)).resolves.toBe(2);
    });
});

describe("issue #797 — the restored facade stays behind the secure-by-default guard", () => {
    it("denies a facade read on a protected table with no rls() in the chain", async () => {
        expect.assertions(1);

        const t = lunoraTest(guardedSchema);

        await t.run(async (ctx) => ctx.db.insert("notes", { body: "hidden", userId: "u1" }));

        await expect(t.withIdentity({ userId: "u1" }).query(unguardedFacadeRead, {})).rejects.toThrow(/rls/i);
    });
});
