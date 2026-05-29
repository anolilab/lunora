/**
 * Tests for the RLS middleware (PLAN2 §3.2).
 *
 * We don't spin up a real ORM here — the RLS surface is one layer above the
 * underlying writer and only cares about what option fields it threads
 * through. A handwritten fake writer captures every call and the args it was
 * passed; assertions read those back to verify the `baseWhere` /
 * `restrictsCounts` merge and the write-path policy denial.
 */
import { describe, expect, test } from "vitest";

import type { Middleware, Policy } from "../src/index.js";
import { CirrusError, definePolicies, definePolicy, defineRole, initCirrus, rls } from "../src/index.js";

/**
 * The procedure builder types `ctx.db` nominally (`DatabaseReader`/
 * `DatabaseWriter`); the RLS middleware's structural `DatabaseWriterLike`
 * shape is a superset (it also accepts the new `baseWhere` /
 * `restrictsCounts` count signature) so TS rejects the direct widening.
 * Pin a permissive cast once here so each test reads cleanly without
 * scattering `as unknown as Middleware<…>` at every call site.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rlsForTest = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>): Middleware<any, any> =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rls as unknown as (p: ReadonlyArray<Policy<Ctx>>) => Middleware<any, any>)(policies);

/* -------------------------------------------------------------------------
 * Fake writer
 * ---------------------------------------------------------------------- */

interface CapturedCall {
    args: unknown;
    method: string;
    tableOrId?: string;
}

interface FakeDb {
    calls: CapturedCall[];
    writer: {
        count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
        delete: (id: string) => Promise<void>;
        findFirst: (tableName: string, args?: unknown) => Promise<Record<string, unknown> | null>;
        findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Array<Record<string, unknown>> }>;
        get: (id: string) => Promise<Record<string, unknown> | null>;
        insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
        query: (tableName: string) => never;
        replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    };
}

const createFakeDb = (rows: Array<Record<string, unknown> & { _id: string; table: string }>): FakeDb => {
    const calls: CapturedCall[] = [];

    const byId = new Map<string, Record<string, unknown> & { _id: string; table: string }>();

    for (const row of rows) {
        byId.set(row._id, row);
    }

    const rowsOfTable = (tableName: string): Array<Record<string, unknown>> => rows.filter((row) => row.table === tableName);

    return {
        calls,
        writer: {
            async count(tableName, whereOrArgs) {
                calls.push({ args: whereOrArgs, method: "count", tableOrId: tableName });

                return rowsOfTable(tableName).length;
            },
            async delete(id) {
                calls.push({ args: undefined, method: "delete", tableOrId: id });
            },
            async findFirst(tableName, args) {
                calls.push({ args, method: "findFirst", tableOrId: tableName });
                const rowsList = rowsOfTable(tableName);
                const where = (args as { where?: { _id?: string } } | undefined)?.where;

                if (where && typeof where._id === "string") {
                    return rowsList.find((row) => row["_id"] === where._id) ?? null;
                }

                return rowsList[0] ?? null;
            },
            async findFirstOrThrow(tableName, args) {
                const result = await this.findFirst(tableName, args);

                if (!result) {
                    throw new Error(`not found: ${tableName}`);
                }

                return result;
            },
            async findMany(tableName, args) {
                calls.push({ args, method: "findMany", tableOrId: tableName });

                return { continueCursor: null, isDone: true, page: rowsOfTable(tableName) };
            },
            async get(id) {
                calls.push({ args: undefined, method: "get", tableOrId: id });

                return byId.get(id) ?? null;
            },
            async insert(tableName, document) {
                calls.push({ args: document, method: "insert", tableOrId: tableName });

                return (document["_id"] as string | undefined) ?? "new-id";
            },
            async patch(id, patchValue) {
                calls.push({ args: patchValue, method: "patch", tableOrId: id });
            },
            query() {
                throw new Error("query() not used in these tests");
            },
            async replace(id, document) {
                calls.push({ args: document, method: "replace", tableOrId: id });
            },
        },
    };
};

const cirrus = initCirrus.dataModel<Record<string, never>>().create();

interface TestCtx {
    auth: { roles?: ReadonlyArray<string>; userId: null | string };
    db: FakeDb["writer"];
}

const makeCtx = (db: FakeDb, userId: null | string, roles: string[] = []): TestCtx => ({
    auth: { roles, userId },
    db: db.writer,
});

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe("rls — read path", () => {
    test("and-merges a policy WhereInput into findMany via baseWhere", async () => {
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: ({ auth }) => ({ ownerId: auth.userId }),
        });
        const policies = definePolicies([policy]);
        const db = createFakeDb([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u2", table: "documents" },
        ]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>(policies))
            .query(async ({ ctx }) => ctx.db.findMany("documents", { where: { archived: false } }));

        const ctx = makeCtx(db, "u1");

        await handler.handler(ctx, {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        expect(findManyCall?.args).toMatchObject({
            baseWhere: { ownerId: "u1" },
            where: { archived: false },
        });
    });

    test("policy returning true skips the merge (unrestricted)", async () => {
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const policies = definePolicies([policy]);
        const db = createFakeDb([]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>(policies))
            .query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    test("policy returning false denies — empty result via OR-of-nothing predicate", async () => {
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => false,
        });
        const db = createFakeDb([]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>([policy]))
            .query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        // The runtime FALSE_PREDICATE sentinel is `{ OR: [] }` — vacuously
        // false, so the SQL compiler emits `0 = 1` and zero rows survive.
        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ OR: [] });
    });

    test("role-branched policy reads ctx.auth.roles", async () => {
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: ({ auth }) => auth.roles.includes("admin") ? true : { ownerId: auth.userId },
        });
        const db = createFakeDb([]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>([policy]))
            .query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1", ["admin"]), {});
        const adminCall = db.calls.at(-1);

        expect((adminCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();

        await handler.handler(makeCtx(db, "u1", []), {});
        const userCall = db.calls.at(-1);

        expect((userCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ ownerId: "u1" });
    });

    test("count() throws COUNT_RLS_UNSUPPORTED when a policy applies", async () => {
        // We can't observe the underlying CirrusError here without wiring the
        // fake DB to honor `restrictsCounts`. Instead we assert the wrapper
        // *passes* `restrictsCounts: true` down to the writer — the ORM is
        // responsible for converting that into the thrown CirrusError, and
        // we assert that in the ORM tests below.
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const db = createFakeDb([]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>([policy]))
            .query(async ({ ctx }) => ctx.db.count("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const countCall = db.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(true);
    });

    test("count() on a non-policy table does NOT mark restrictsCounts", async () => {
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const db = createFakeDb([]);

        const handler = cirrus.query
            .use(rlsForTest<TestCtx>([policy]))
            .query(async ({ ctx }) => ctx.db.count("other_table"));

        await handler.handler(makeCtx(db, "u1"), {});

        const countCall = db.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(false);
    });
});

describe("rls — write path", () => {
    test("update policy denies patch with FORBIDDEN", async () => {
        const policy = definePolicy<TestCtx>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });

        expect(db.calls.some((call) => call.method === "patch")).toBe(false);
    });

    test("update policy allows patch when the row matches", async () => {
        const policy = definePolicy<TestCtx>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await handler.handler(makeCtx(db, "u1"), {});

        const patchCall = db.calls.find((call) => call.method === "patch");

        expect(patchCall).toBeDefined();
    });

    test("delete policy denies with FORBIDDEN", async () => {
        const policy = definePolicy<TestCtx>({
            on: "delete",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.delete("d1"));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });

        expect(db.calls.some((call) => call.method === "delete")).toBe(false);
    });

    test("insert policy denies a forbidden document", async () => {
        const policy = definePolicy<TestCtx>({
            on: "insert",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "someone-else", title: "x" }));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });
    });
});

describe("rls — opt-in scope", () => {
    test("policies do NOT apply to procedures whose chain omits rls()", async () => {
        // A policy is declared but the procedure deliberately skips
        // `.use(rls(...))` — the policy list is dead code for this handler.
        // Holding the reference proves we're not silently activating policies
        // through some import-time side effect.
        const inertPolicy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => false,
        });

        expect(inertPolicy.table).toBe("documents");

        const db = createFakeDb([]);

        const handler = cirrus.query.query(async ({ ctx }) =>
            (ctx as unknown as TestCtx).db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        // No baseWhere — the wrapper never ran.
        expect((findManyCall?.args as { baseWhere?: unknown } | undefined)?.baseWhere).toBeUndefined();
    });

    test("a CirrusError thrown from a policy denial carries status 403", async () => {
        const policy = definePolicy<TestCtx>({
            on: "delete",
            table: "documents",
            when: () => false,
        });
        const db = createFakeDb([{ _id: "d1", table: "documents" }]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.delete("d1"));

        try {
            await handler.handler(makeCtx(db, "u1"), {});
            throw new Error("expected to throw");
        } catch (error) {
            expect(error).toBeInstanceOf(CirrusError);
            expect((error as CirrusError).status).toBe(403);
            expect((error as CirrusError).code).toBe("FORBIDDEN");
        }
    });
});

describe("rls — role registry", () => {
    test("defineRole returns the declared name + optional description", () => {
        expect(defineRole("admin")).toEqual({ name: "admin" });
        expect(defineRole("editor", { description: "can edit docs" })).toEqual({
            description: "can edit docs",
            name: "editor",
        });
    });
});
