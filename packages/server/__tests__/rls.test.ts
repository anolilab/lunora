/**
 * Tests for the RLS middleware (PLAN2 §3.2).
 *
 * We don't spin up a real ORM here — the RLS surface is one layer above the
 * underlying writer and only cares about what option fields it threads
 * through. A handwritten fake writer captures every call and the args it was
 * passed; assertions read those back to verify the `baseWhere` /
 * `restrictsCounts` merge and the write-path policy denial.
 */
import { describe, expect, it } from "vitest";

import type { Middleware, Policy } from "../src/index.js";
import { CirrusError, definePolicies, definePolicy, defineRole, initCirrus, rls } from "../src/index.js";

/**
 * The procedure builder types `ctx.db` nominally (`DatabaseReader`/
 * `DatabaseWriter`); the RLS middleware's structural `DatabaseWriterLike`
 * shape is a superset (it also accepts the new `baseWhere` /
 * `restrictsCounts` count signature) so TS rejects the direct widening.
 * Pin a permissive cast once here so each test reads cleanly without
 * scattering `as unknown as Middleware&lt;…>` at every call site.
 */
const rlsForTest = <Ctx>(policies: ReadonlyArray<Policy<Ctx>>): Middleware<any, any> =>
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
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        get: (id: string) => Promise<Record<string, unknown> | null>;
        insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
        query: (tableName: string) => never;
        replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    };
}

const createFakeDb = (rows: (Record<string, unknown> & { _id: string; table: string })[]): FakeDb => {
    const calls: CapturedCall[] = [];

    const byId = new Map<string, Record<string, unknown> & { _id: string; table: string }>();

    for (const row of rows) {
        byId.set(row._id, row);
    }

    const rowsOfTable = (tableName: string): Record<string, unknown>[] => rows.filter((row) => row.table === tableName);

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

const makeCtx = (db: FakeDb, userId: null | string, roles: string[] = []): TestCtx => {
    return {
        auth: { roles, userId },
        db: db.writer,
    };
};

/** Build a one-off insert handler running through an `rls()` chain over a single policy. */
const insertWithPolicy = (policy: Policy<TestCtx>) => (document: Record<string, unknown>) =>
    cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.insert("documents", document));

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe("rls — read path", () => {
    it("and-merges a policy WhereInput into findMany via baseWhere", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const policies = definePolicies([policy]);
        const db = createFakeDb([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u2", table: "documents" },
        ]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>(policies)).query(async ({ ctx }) => ctx.db.findMany("documents", { where: { archived: false } }));

        const ctx = makeCtx(db, "u1");

        await handler.handler(ctx, {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        expect(findManyCall?.args).toMatchObject({
            baseWhere: { ownerId: "u1" },
            where: { archived: false },
        });
    });

    it("policy returning true skips the merge (unrestricted)", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const policies = definePolicies([policy]);
        const db = createFakeDb([]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>(policies)).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    it("policy returning false denies — empty result via OR-of-nothing predicate", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => false,
        });
        const db = createFakeDb([]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        // The runtime FALSE_PREDICATE sentinel is `{ OR: [] }` — vacuously
        // false, so the SQL compiler emits `0 = 1` and zero rows survive.
        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ OR: [] });
    });

    it("role-branched policy reads ctx.auth.roles", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("admin") ? true : { ownerId: auth.userId }),
        });
        const db = createFakeDb([]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1", ["admin"]), {});
        const adminCall = db.calls.at(-1);

        expect((adminCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();

        await handler.handler(makeCtx(db, "u1", []), {});
        const userCall = db.calls.at(-1);

        expect((userCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ ownerId: "u1" });
    });

    it("count() throws COUNT_RLS_UNSUPPORTED when a policy applies", async () => {
        expect.hasAssertions();

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

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.count("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const countCall = db.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(true);
    });

    it("get() does NOT leak a row that the read policy denied (regression)", async () => {
        expect.assertions(1);

        // Policy applies to "documents" and would AND-merge `{ ownerId: "u1" }`.
        // Our row has `ownerId: "u2"` so the policy denies it.
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        // Honest fake: when `baseWhere` is set the membership check returns
        // null if the row doesn't satisfy the predicate — mirroring what
        // `@cirrus/do`'s `findFirst` does at runtime. The buggy wrapper used
        // to swallow this null and fall through to the unrestricted `row`
        // from `base.get()`, leaking what the policy was meant to hide.
        const fake = createFakeDb([{ _id: "d1", ownerId: "u2", table: "documents" }]);
        const wrappedFindFirst = fake.writer.findFirst;

        fake.writer.findFirst = async (tableName, args) => {
            const candidate = await wrappedFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: unknown } } | undefined)?.baseWhere;

            if (!candidate || !baseWhere || !("ownerId" in baseWhere)) {
                return candidate;
            }

            return candidate["ownerId"] === baseWhere.ownerId ? candidate : null;
        };

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.get("d1"));

        await expect(handler.handler(makeCtx(fake, "u1"), {})).resolves.toBeNull();
    });

    it("get() on a row outside every policy-gated table returns the row unrestricted", async () => {
        expect.assertions(2);

        // Policy applies to "documents"; the requested row lives in "audit",
        // which carries no policy — the wrapper must pass it through, not
        // accidentally treat it as policy-denied.
        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "anyone" };
            },
        });

        const fake = createFakeDb([{ _id: "a1", table: "audit", event: "login" }]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.get("a1"));

        const result = await handler.handler(makeCtx(fake, "u1"), {});

        expect(result?.["_id"]).toBe("a1");
        expect(result?.["event"]).toBe("login");
    });

    it("count() on a non-policy table does NOT mark restrictsCounts", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const db = createFakeDb([]);

        const handler = cirrus.query.use(rlsForTest<TestCtx>([policy])).query(async ({ ctx }) => ctx.db.count("other_table"));

        await handler.handler(makeCtx(db, "u1"), {});

        const countCall = db.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(false);
    });
});

describe("rls — write path", () => {
    it("update policy denies patch with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestCtx>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });

        expect(db.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("update policy allows patch when the row matches", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await handler.handler(makeCtx(db, "u1"), {});

        const patchCall = db.calls.find((call) => call.method === "patch");

        expect(patchCall).toBeDefined();
    });

    it("delete policy denies with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestCtx>({
            on: "delete",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const db = createFakeDb([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1"));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });

        expect(db.calls.some((call) => call.method === "delete")).toBe(false);
    });

    it("insert policy denies a forbidden document", async () => {
        expect.assertions(1);

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

describe("rls — write policies returning a WhereInput predicate", () => {
    it("insert: predicate matches the candidate document → allow", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const db = createFakeDb([]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "u1", title: "x" }));

        await handler.handler(makeCtx(db, "u1"), {});

        expect(db.calls.some((call) => call.method === "insert")).toBe(true);
    });

    it("insert: predicate mismatch denies with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestCtx>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const db = createFakeDb([]);

        const handler = cirrus.mutation
            .use(rlsForTest<TestCtx>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "someone-else", title: "x" }));

        await expect(handler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "CirrusError",
        });
        expect(db.calls.some((call) => call.method === "insert")).toBe(false);
    });

    it("update: predicate evaluates against the pre-write row", async () => {
        expect.assertions(3);

        const policy = definePolicy<TestCtx>({
            on: "update",
            table: "documents",
            when: () => {
                return { archived: { eq: false } };
            },
        });
        const allowed = createFakeDb([{ _id: "d1", archived: false, table: "documents" }]);
        const denied = createFakeDb([{ _id: "d2", archived: true, table: "documents" }]);

        const allowedHandler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));
        const deniedHandler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d2", { title: "new" }));

        await allowedHandler.handler(makeCtx(allowed, "u1"), {});

        expect(allowed.calls.some((call) => call.method === "patch")).toBe(true);

        await expect(deniedHandler.handler(makeCtx(denied, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(denied.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("delete: predicate evaluates against the pre-write row", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestCtx>({
            on: "delete",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const db = createFakeDb([
            { _id: "mine", ownerId: "u1", table: "documents" },
            { _id: "theirs", ownerId: "u2", table: "documents" },
        ]);

        const allowedHandler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.delete("mine"));
        const deniedHandler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.delete("theirs"));

        await allowedHandler.handler(makeCtx(db, "u1"), {});

        expect(db.calls.some((call) => call.method === "delete")).toBe(true);

        await expect(deniedHandler.handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("operator coverage: lt / in / contains / AND honored on writes", async () => {
        expect.assertions(5);

        const policy = definePolicy<TestCtx>({
            on: "insert",
            table: "documents",
            when: () => {
                return {
                    AND: [{ priority: { lt: 5 } }, { status: { in: ["draft", "review"] } }, { title: { contains: "urgent" } }],
                };
            },
        });
        const db = createFakeDb([]);

        const handler = insertWithPolicy(policy);

        // Matches every branch — allowed.
        await handler({ priority: 3, status: "draft", title: "urgent fix" }).handler(makeCtx(db, "u1"), {});

        expect(db.calls.filter((call) => call.method === "insert")).toHaveLength(1);

        // lt fails (5 is NOT less than 5).
        await expect(handler({ priority: 5, status: "draft", title: "urgent fix" }).handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // in fails.
        await expect(handler({ priority: 1, status: "archived", title: "urgent" }).handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // contains fails.
        await expect(handler({ priority: 1, status: "draft", title: "trivial" }).handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // null/undefined never matches an ordered comparator (SQL NULL
        // semantics) — `priority: null` with `lt: 5` denies.
        await expect(handler({ priority: null, status: "draft", title: "urgent" }).handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("oR branch: any matching sub-predicate allows the write", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestCtx>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return {
                    OR: [{ ownerId: { eq: auth.userId } }, { visibility: { eq: "public" } }],
                };
            },
        });
        const db = createFakeDb([]);

        const handler = insertWithPolicy(policy);

        // OR-left matches (ownerId).
        await handler({ ownerId: "u1", visibility: "private" }).handler(makeCtx(db, "u1"), {});

        // OR-right matches (public visibility — different owner).
        await handler({ ownerId: "u2", visibility: "public" }).handler(makeCtx(db, "u1"), {});

        // Neither matches — denied.
        await expect(handler({ ownerId: "u2", visibility: "private" }).handler(makeCtx(db, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });
});

describe("rls — opt-in scope", () => {
    it("policies do NOT apply to procedures whose chain omits rls()", async () => {
        expect.hasAssertions();

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

        const handler = cirrus.query.query(async ({ ctx }) => (ctx as unknown as TestCtx).db.findMany("documents"));

        await handler.handler(makeCtx(db, "u1"), {});

        const findManyCall = db.calls.find((call) => call.method === "findMany");

        // No baseWhere — the wrapper never ran.
        expect((findManyCall?.args as { baseWhere?: unknown } | undefined)?.baseWhere).toBeUndefined();
    });

    it("a CirrusError thrown from a policy denial carries status 403", async () => {
        expect.assertions(3);

        const policy = definePolicy<TestCtx>({
            on: "delete",
            table: "documents",
            when: () => false,
        });
        const db = createFakeDb([{ _id: "d1", table: "documents" }]);

        const handler = cirrus.mutation.use(rlsForTest<TestCtx>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1"));

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
    it("defineRole returns the declared name + optional description", () => {
        expect.assertions(2);

        expect(defineRole("admin")).toEqual({ name: "admin" });
        expect(defineRole("editor", { description: "can edit docs" })).toEqual({
            description: "can edit docs",
            name: "editor",
        });
    });
});
