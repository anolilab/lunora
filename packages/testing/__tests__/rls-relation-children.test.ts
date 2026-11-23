/**
 * Under `.rls("required")` a protected table with no read policy is closed to a
 * direct read, and these tests pin that it stays closed when it is reached as a
 * RELATION of a readable parent instead: a `with` load, a `_count`, or a nested
 * `with` one level down. The child fetch runs inside the engine's relation
 * resolver against the unwrapped writer, so neither the guard nor a fake writer
 * sees it — this runs the real engine.
 */
import type { Middleware, Policy } from "@lunora/server";
import { definePolicies, definePolicy, defineSchema, defineTable, initLunora, mask, rls, v } from "@lunora/server";
import { afterEach, describe, expect, it } from "vitest";

import { lunoraTest } from "../src/index";
import trackHarnesses from "./harness-tracker";

const { mutation, query } = initLunora.dataModel().create();

/** See `rls-enforcement.test.ts`: the raw builder types `ctx.db` nominally, so the middleware is cast once here. */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

const schema = defineSchema({
    audit: defineTable({ note: v.string(), postId: v.string() })
        .public()
        .relations((r) => {
            return { secrets: r.many("secrets", { field: "auditId" }) };
        }),
    notices: defineTable({ score: v.number(), text: v.string() })
        .public()
        .relations((r) => {
            return { secrets: r.many("secrets", { field: "noticeId" }) };
        }),
    posts: defineTable({ title: v.string() }).relations((r) => {
        return {
            audit: r.many("audit", { field: "postId" }),
            secrets: r.many("secrets", { field: "postId" }),
        };
    }),
    secrets: defineTable({ auditId: v.string(), body: v.string(), noticeId: v.string(), postId: v.string() }),
}).rls("required");

const readPosts = definePolicy({ on: "read", table: "posts", when: () => true });

/** The writer surface these reads use; the builder's nominal `ctx.db` type does not list `findMany`. */
type FindMany = (table: string, args: Record<string, unknown>) => Promise<{ page: Record<string, unknown>[] }>;

const postsWith = (withInput: Record<string, unknown>) =>
    query
        .use(rlsForTest(definePolicies([readPosts])))
        .query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("posts", { with: withInput }));

/** No `rls()` at all: the guard admits the `.public()` parent, and the child must still be refused. */
const noticesWithSecrets = query.query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("notices", { with: { secrets: true } }));

/** The analytical reads; the builder's nominal `ctx.db` type does not list them. */
interface Analytical {
    aggregate: (table: string, options: Record<string, unknown>) => Promise<unknown>;
    count: (table: string, whereOrArgs?: Record<string, unknown>) => Promise<number>;
    explain: (table: string, args: Record<string, unknown>) => Promise<unknown>;
    groupBy: (table: string, options: Record<string, unknown>) => Promise<unknown>;
}

type AnalyticalRead = (database: Analytical, table: string, where: Record<string, unknown>) => Promise<unknown>;

const analyticalReads: ReadonlyArray<[string, AnalyticalRead]> = [
    ["count with a bare where", async (database, table, where) => database.count(table, where)],
    ["count with an options bag", async (database, table, where) => database.count(table, { where })],
    ["count with a caller baseWhere", async (database, table, where) => database.count(table, { baseWhere: where })],
    ["aggregate", async (database, table, where) => database.aggregate(table, { field: "score", op: "sum", where })],
    ["aggregate op count", async (database, table, where) => database.aggregate(table, { op: "count", where })],
    ["aggregate with a caller baseWhere", async (database, table, where) => database.aggregate(table, { baseWhere: where, field: "score", op: "sum" })],
    ["groupBy", async (database, table, where) => database.groupBy(table, { by: ["text"], where })],
    // The plan's params carry what the relation predicate resolved to, so it reads the child too.
    ["explain", async (database, table, where) => database.explain(table, { where })],
];

const relationPredicates: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["some", { secrets: { some: { body: "s" } } }],
    ["every", { secrets: { every: { body: "s" } } }],
    ["none", { secrets: { none: { body: "s" } } }],
];

const analyticalCases = analyticalReads.flatMap(([readName, read]) =>
    relationPredicates.map(([predicateName, where]) => [`${readName} / ${predicateName}`, read, where] as const),
);

/** A `.public()` parent with no `rls()` step, so only the guard stands between the read and the child. */
const unguardedAnalytical = (read: AnalyticalRead, where: Record<string, unknown>) =>
    query.query(async ({ ctx }) => read(ctx.db as unknown as Analytical, "notices", where));

/** The parent behind an `rls()` read policy, so the middleware's relation filter carries the read. */
const policiedAnalytical = (read: AnalyticalRead, where: Record<string, unknown>) =>
    query.use(rlsForTest(definePolicies([readPosts]))).query(async ({ ctx }) => read(ctx.db as unknown as Analytical, "posts", where));

/**
 * `mask()` ahead of `rls()`: the mask republishes `ctx.db` by spread, so the
 * `rls()` step below it sees the mask wrapper rather than the guarded writer.
 */
const maskedThenPolicied = <T>(read: (database: Analytical & { findMany: FindMany }) => Promise<T>) =>
    query
        .use(mask({ audit: { note: "redact" } }) as unknown as Middleware<any, any>)
        .use(rlsForTest(definePolicies([readPosts])))
        .query(async ({ ctx }) => read(ctx.db as unknown as Analytical & { findMany: FindMany }));

/** No `rls()`, and the caller hands in its own relation filter: it must not stand in for the middleware's. */
const noticesWithFilter = (relationBaseWhere: unknown) =>
    query.query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("notices", { relationBaseWhere, with: { secrets: true } }));

const readSecrets = definePolicy({ on: "read", table: "secrets", when: () => true });

/** The child has a read policy too, so the relation load is allowed. */
const postsWithPoliciedSecrets = query
    .use(rlsForTest(definePolicies([readPosts, readSecrets])))
    .query(async ({ ctx }) => (ctx.db as unknown as { findMany: FindMany }).findMany("posts", { with: { secrets: true } }));

/** The where-based bulk writes; the builder's nominal `ctx.db` type does not list them. */
interface BulkWrites {
    deleteWhere: (table: string, where: Record<string, unknown>) => Promise<unknown>;
    patchWhere: (table: string, args: { patch: Record<string, unknown>; where: Record<string, unknown> }) => Promise<unknown>;
}

const harnesses = trackHarnesses();

const seeded = async (): Promise<ReturnType<typeof lunoraTest>> => {
    const t = lunoraTest(schema);

    harnesses.track(t);

    await t.run(async (ctx) => {
        const database = ctx.db as unknown as {
            insert: (table: string, document: Record<string, unknown>, options?: { allowExplicitId?: boolean }) => Promise<string>;
        };

        await database.insert("posts", { _id: "p1", title: "t" }, { allowExplicitId: true });
        await database.insert("notices", { _id: "n1", score: 1, text: "n" }, { allowExplicitId: true });
        await database.insert("audit", { _id: "a1", note: "a", postId: "p1" }, { allowExplicitId: true });
        await database.insert("secrets", { auditId: "a1", body: "s", noticeId: "n1", postId: "p1" });
    });

    return t;
};

describe("lunoraTest — relation reads of a protected table without a read policy", () => {
    afterEach(() => {
        harnesses.closeAll();
    });

    it("refuses a with-load of the protected child", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ secrets: true }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses a _count of the protected child", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ _count: { secrets: true } }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses the protected table one level down a nested with", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(postsWith({ audit: { with: { secrets: true } } }), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("refuses the protected child of a .public() parent read without rls()", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(noticesWithSecrets, {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it.each([
        ["a callback answering no filter", () => undefined],
        ["null", null],
    ])("refuses the protected child when the caller supplies %s as its relation filter", async (_label, relationBaseWhere) => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(noticesWithFilter(relationBaseWhere), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it("still loads a protected child its read policy allows", async () => {
        expect.assertions(1);

        const t = await seeded();
        const { page } = await t.query(postsWithPoliciedSecrets, {});

        expect(page.map((post) => (post["secrets"] as Record<string, unknown>[]).map((row) => row["body"]))).toStrictEqual([["s"]]);
    });

    it.each([
        ["deleteWhere", async (database: BulkWrites) => database.deleteWhere("notices", { secrets: { some: { body: "s" } } })],
        ["patchWhere", async (database: BulkWrites) => database.patchWhere("notices", { patch: { text: "x" }, where: { secrets: { some: { body: "s" } } } })],
    ] as const)("refuses a %s on a .public() parent filtered by the protected child without rls()", async (_name, write) => {
        expect.assertions(1);

        const t = await seeded();

        // The matched count would otherwise tell the handler what the hidden child rows hold.
        await expect(
            t.mutation(
                mutation.mutation(async ({ ctx }) => write(ctx.db as unknown as BulkWrites)),
                {},
            ),
        ).rejects.toMatchObject({
            code: "RLS_REQUIRED",
            table: "secrets",
        });
    });

    it("still loads a .public() child", async () => {
        expect.assertions(1);

        const t = await seeded();
        const { page } = await t.query(postsWith({ audit: true }), {});

        expect(page.map((post) => (post["audit"] as Record<string, unknown>[]).map((row) => row["_id"]))).toStrictEqual([["a1"]]);
    });

    it.each(analyticalCases)("refuses a relation predicate on the protected child in %s of a .public() parent without rls()", async (_name, read, where) => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(unguardedAnalytical(read, where), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it.each(analyticalCases)("refuses a relation predicate on the protected child in %s of a policied parent", async (_name, read, where) => {
        expect.assertions(1);

        const t = await seeded();

        await expect(t.query(policiedAnalytical(read, where), {})).rejects.toMatchObject({ code: "RLS_REQUIRED", table: "secrets" });
    });

    it.each([
        [
            "count",
            async (database: Analytical, relationBaseWhere: unknown) =>
                database.count("notices", { relationBaseWhere, where: { secrets: { some: { body: "s" } } } }),
        ],
        [
            "aggregate",
            async (database: Analytical, relationBaseWhere: unknown) =>
                database.aggregate("notices", { field: "score", op: "sum", relationBaseWhere, where: { secrets: { some: { body: "s" } } } }),
        ],
        [
            "groupBy",
            async (database: Analytical, relationBaseWhere: unknown) =>
                database.groupBy("notices", { by: ["text"], relationBaseWhere, where: { secrets: { some: { body: "s" } } } }),
        ],
    ] as const)("refuses a relation predicate on the protected child in %s when the caller supplies its own relation filter", async (_name, read) => {
        expect.assertions(2);

        const t = await seeded();

        for (const relationBaseWhere of [() => undefined, null]) {
            // eslint-disable-next-line no-await-in-loop -- one harness, the two filters checked in turn
            await expect(
                t.query(
                    query.query(async ({ ctx }) => read(ctx.db as unknown as Analytical, relationBaseWhere)),
                    {},
                ),
            ).rejects.toMatchObject({
                code: "RLS_REQUIRED",
                table: "secrets",
            });
        }
    });

    it("still counts a .public() parent by a relation predicate on a .public() child", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(
            t.query(
                policiedAnalytical(async (database, _table, where) => database.count("posts", where), { audit: { some: { note: "a" } } }),
                {},
            ),
        ).resolves.toBe(1);
    });

    it("refuses the protected child of a .public() parent when mask() runs ahead of rls()", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(
            t.query(
                maskedThenPolicied(async (database) => database.findMany("notices", { with: { secrets: true } })),
                {},
            ),
        ).rejects.toMatchObject({
            code: "RLS_REQUIRED",
            table: "secrets",
        });
    });

    it("refuses a relation predicate on the protected child when mask() runs ahead of rls()", async () => {
        expect.assertions(1);

        const t = await seeded();

        await expect(
            t.query(
                maskedThenPolicied(async (database) => database.count("notices", { secrets: { some: {} } })),
                {},
            ),
        ).rejects.toMatchObject({
            code: "RLS_REQUIRED",
            table: "secrets",
        });
    });
});
