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

import type { Middleware, Policy, Role } from "../src/index";
import { LunoraError, definePermission, definePolicies, definePolicy, defineRole, initLunora, rls } from "../src/index";

/**
 * The procedure builder types `ctx.db` nominally (`DatabaseReader`/
 * `DatabaseWriter`); the RLS middleware's structural `DatabaseWriterLike`
 * shape is a superset (it also accepts the new `baseWhere` /
 * `restrictsCounts` count signature) so TS rejects the direct widening.
 * Pin a permissive cast once here so each test reads cleanly without
 * scattering `as unknown as Middleware&lt;…>` at every call site.
 */
const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

/* -------------------------------------------------------------------------
 * Fake writer
 * ---------------------------------------------------------------------- */

interface CapturedCall {
    args: unknown;
    method: string;
    tableOrId?: string;
}

interface FakeDatabase {
    calls: CapturedCall[];
    writer: {
        aggregate: (tableName: string, options: unknown) => Promise<null | number>;
        count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
        delete: (id: string) => Promise<void>;
        findFirst: (tableName: string, args?: unknown) => Promise<Record<string, unknown> | null>;
        findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        get: (id: string) => Promise<Record<string, unknown> | null>;
        getWithTable?: (id: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
        groupBy: (tableName: string, options: unknown) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
        insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
        query: (tableName: string) => never;
        rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
        rankBefore: (tableName: string, indexName: string, options: unknown) => Promise<{ before: number; total: number }>;
        rankPage: (
            tableName: string,
            indexName: string,
            options?: unknown,
        ) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        replace: (id: string, document: Record<string, unknown>) => Promise<void>;
    };
}

const createFakeDatabase = (rows: (Record<string, unknown> & { _id: string; table: string })[]): FakeDatabase => {
    const calls: CapturedCall[] = [];

    const byId = new Map<string, Record<string, unknown> & { _id: string; table: string }>();

    for (const row of rows) {
        byId.set(row._id, row);
    }

    const rowsOfTable = (tableName: string): Record<string, unknown>[] => rows.filter((row) => row.table === tableName);

    return {
        calls,
        writer: {
            async aggregate(tableName, options) {
                calls.push({ args: options, method: "aggregate", tableOrId: tableName });

                return rowsOfTable(tableName).length;
            },
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
            async groupBy(tableName, options) {
                calls.push({ args: options, method: "groupBy", tableOrId: tableName });

                return [{ key: {}, value: rowsOfTable(tableName).length }];
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
            async rank(tableName, _indexName, options) {
                calls.push({ args: options, method: "rank", tableOrId: tableName });

                return { position: 1, total: rowsOfTable(tableName).length };
            },
            async rankBefore(tableName, _indexName, options) {
                calls.push({ args: options, method: "rankBefore", tableOrId: tableName });

                return { before: 0, total: rowsOfTable(tableName).length };
            },
            async rankPage(tableName, _indexName, options) {
                calls.push({ args: options, method: "rankPage", tableOrId: tableName });

                return { continueCursor: null, isDone: true, page: rowsOfTable(tableName) };
            },
            async replace(id, document) {
                calls.push({ args: document, method: "replace", tableOrId: id });
            },
        },
    };
};

/**
 * Enable the optional `getWithTable` fast-path seam on a fake writer, answering
 * `{ row, tableName }` from the seeded rows in one shot — mirroring what
 * `@lunora/do`'s `lookupById` returns. Records a `getWithTable` call so a test
 * can assert the probe fan-out (`findFirst` per policy table) was skipped.
 */
const enableGetWithTable = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    const byId = new Map(rows.map((row) => [row._id, row] as const));

    // eslint-disable-next-line no-param-reassign -- the helper's purpose is to install the seam on the caller's fake writer
    database.writer.getWithTable = async (id) => {
        database.calls.push({ args: undefined, method: "getWithTable", tableOrId: id });
        const row = byId.get(id);

        return row ? { row, tableName: row.table } : null;
    };
};

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface TestContext {
    auth: { roles?: ReadonlyArray<string>; userId: null | string };
    db: FakeDatabase["writer"];
}

const makeContext = (database: FakeDatabase, userId: null | string, roles: string[] = []): TestContext => {
    return {
        auth: { roles, userId },
        db: database.writer,
    };
};

/** Build a one-off insert handler running through an `rls()` chain over a single policy. */
const insertWithPolicy = (policy: Policy<TestContext>) => (document: Record<string, unknown>) =>
    lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.insert("documents", document));

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe("rls — read path", () => {
    it("and-merges a policy WhereInput into findMany via baseWhere", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const policies = definePolicies([policy]);
        const database = createFakeDatabase([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u2", table: "documents" },
        ]);

        const handler = lunora.query
            .use(rlsForTest<TestContext>(policies))
            .query(async ({ ctx }) => ctx.db.findMany("documents", { where: { archived: false } }));

        const context = makeContext(database, "u1");

        await handler.handler(context, {});

        const findManyCall = database.calls.find((call) => call.method === "findMany");

        expect(findManyCall?.args).toMatchObject({
            baseWhere: { ownerId: "u1" },
            where: { archived: false },
        });
    });

    it("policy returning true skips the merge (unrestricted)", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const policies = definePolicies([policy]);
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>(policies)).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        const findManyCall = database.calls.find((call) => call.method === "findMany");

        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    it("policy returning false denies — empty result via OR-of-nothing predicate", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => false,
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        const findManyCall = database.calls.find((call) => call.method === "findMany");

        // The runtime FALSE_PREDICATE sentinel is `{ OR: [] }` — vacuously
        // false, so the SQL compiler emits `0 = 1` and zero rows survive.
        expect((findManyCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ OR: [] });
    });

    it("role-branched policy reads ctx.auth.roles", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("admin") ? true : { ownerId: auth.userId }),
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeContext(database, "u1", ["admin"]), {});
        const adminCall = database.calls.at(-1);

        expect((adminCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();

        await handler.handler(makeContext(database, "u1", []), {});
        const userCall = database.calls.at(-1);

        expect((userCall?.args as { baseWhere?: unknown }).baseWhere).toEqual({ ownerId: "u1" });
    });

    it("count() throws COUNT_RLS_UNSUPPORTED when a policy applies", async () => {
        expect.hasAssertions();

        // We can't observe the underlying LunoraError here without wiring the
        // fake DB to honor `restrictsCounts`. Instead we assert the wrapper
        // *passes* `restrictsCounts: true` down to the writer — the ORM is
        // responsible for converting that into the thrown LunoraError, and
        // we assert that in the ORM tests below.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.count("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        const countCall = database.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(true);
    });

    it("get() does NOT leak a row that the read policy denied (regression)", async () => {
        expect.assertions(1);

        // Policy applies to "documents" and would AND-merge `{ ownerId: "u1" }`.
        // Our row has `ownerId: "u2"` so the policy denies it.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        // Honest fake: when `baseWhere` is set the membership check returns
        // null if the row doesn't satisfy the predicate — mirroring what
        // `@lunora/do`'s `findFirst` does at runtime. The buggy wrapper used
        // to swallow this null and fall through to the unrestricted `row`
        // from `base.get()`, leaking what the policy was meant to hide.
        const fake = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);
        const wrappedFindFirst = fake.writer.findFirst;

        fake.writer.findFirst = async (tableName, args) => {
            const candidate = await wrappedFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: unknown } } | undefined)?.baseWhere;

            if (!candidate || !baseWhere || !("ownerId" in baseWhere)) {
                return candidate;
            }

            return candidate["ownerId"] === baseWhere.ownerId ? candidate : null;
        };

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("d1"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
    });

    it("get() on a row outside every policy-gated table returns the row unrestricted", async () => {
        expect.assertions(2);

        // Policy applies to "documents"; the requested row lives in "audit",
        // which carries no policy — the wrapper must pass it through, not
        // accidentally treat it as policy-denied.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "anyone" };
            },
        });

        const fake = createFakeDatabase([{ _id: "a1", event: "login", table: "audit" }]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("a1"));

        const result = await handler.handler(makeContext(fake, "u1"), {});

        expect(result?.["_id"]).toBe("a1");
        expect(result?.["event"]).toBe("login");
    });

    it("get() distinguishes deny from absent across 2+ policy-gated tables", async () => {
        expect.assertions(3);

        // Two policy-gated tables. The requested id lives in "documents" but
        // its ownerId fails the predicate, so the policy DENIES it. A wrong
        // fall-through (treating the failed baseWhere fetch as "not in this
        // table" and returning the unguarded row) would leak the hidden row.
        const docsPolicy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const notesPolicy = definePolicy<TestContext>({
            on: "read",
            table: "notes",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        const fake = createFakeDatabase([
            { _id: "d1", ownerId: "u2", table: "documents" },
            { _id: "n1", ownerId: "u1", table: "notes" },
        ]);
        const wrappedFindFirst = fake.writer.findFirst;

        // Honest fake: a baseWhere-scoped findFirst filters by the predicate.
        fake.writer.findFirst = async (tableName, args) => {
            const candidate = await wrappedFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: unknown } } | undefined)?.baseWhere;

            if (!candidate || !baseWhere || !("ownerId" in baseWhere)) {
                return candidate;
            }

            return candidate["ownerId"] === baseWhere.ownerId ? candidate : null;
        };

        const denied = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("d1"));
        const allowed = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("n1"));
        const absent = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("missing"));

        // d1 exists in "documents" but is denied → null (NOT the leaked row).
        await expect(denied.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
        // n1 exists in "notes" and is owned by u1 → returned.
        await expect(allowed.handler(makeContext(fake, "u1"), {})).resolves.toMatchObject({ _id: "n1" });
        // missing id → null.
        await expect(absent.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
    });

    it("get() uses the getWithTable fast path and skips the probe fan-out when present", async () => {
        expect.assertions(3);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        const rows = [
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "x1", ownerId: "u1", table: "other" },
        ];
        const fake = createFakeDatabase(rows);

        enableGetWithTable(fake, rows);

        // Owned + allowed: single getWithTable lookup + one policy-check findFirst.
        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("d1"));
        const result = await handler.handler(makeContext(fake, "u1"), {});

        expect(result?.["_id"]).toBe("d1");
        expect(fake.calls.some((call) => call.method === "getWithTable")).toBe(true);

        // No membership probe fan-out: the only findFirst is the policy check on
        // the owning table (with a baseWhere), never an unscoped probe.
        const unscopedProbes = fake.calls.filter((call) => call.method === "findFirst" && !(call.args as { baseWhere?: unknown } | undefined)?.baseWhere);

        expect(unscopedProbes).toHaveLength(0);
    });

    it("count() on a non-policy table does NOT mark restrictsCounts", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => true,
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.count("other_table"));

        await handler.handler(makeContext(database, "u1"), {});

        const countCall = database.calls.find((call) => call.method === "count");

        expect((countCall?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(false);
    });
});

describe("rls — write path", () => {
    it("update policy denies patch with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });

        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("update policy allows patch when the row matches", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));

        await handler.handler(makeContext(database, "u1"), {});

        const patchCall = database.calls.find((call) => call.method === "patch");

        expect(patchCall).toBeDefined();
    });

    it("delete policy denies with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "delete",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1"));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });

        expect(database.calls.some((call) => call.method === "delete")).toBe(false);
    });

    it("insert policy denies a forbidden document", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "someone-else", title: "x" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });
    });
});

describe("rls — write policies returning a WhereInput predicate", () => {
    it("insert: predicate matches the candidate document → allow", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const database = createFakeDatabase([]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "u1", title: "x" }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "insert")).toBe(true);
    });

    it("insert: a predicate referencing a writer-assigned system field denies (documented limitation)", async () => {
        expect.assertions(2);

        // The insert policy is evaluated against the caller's candidate document
        // BEFORE the writer stamps `_id`/`_creationTime`, so a predicate keyed
        // on `_id` can never match the candidate → the insert is denied. This
        // locks in the documented behavior (author insert policies against
        // user-supplied fields, not system fields).
        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: () => {
                return { _id: { eq: "anything" } };
            },
        });
        const database = createFakeDatabase([]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "u1", title: "x" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });
        expect(database.calls.some((call) => call.method === "insert")).toBe(false);
    });

    it("insert: predicate mismatch denies with FORBIDDEN", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const database = createFakeDatabase([]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "someone-else", title: "x" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });
        expect(database.calls.some((call) => call.method === "insert")).toBe(false);
    });

    it("update: predicate evaluates against the pre-write row", async () => {
        expect.assertions(3);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: () => {
                return { archived: { eq: false } };
            },
        });
        const allowed = createFakeDatabase([{ _id: "d1", archived: false, table: "documents" }]);
        const denied = createFakeDatabase([{ _id: "d2", archived: true, table: "documents" }]);

        const allowedHandler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { title: "new" }));
        const deniedHandler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d2", { title: "new" }));

        await allowedHandler.handler(makeContext(allowed, "u1"), {});

        expect(allowed.calls.some((call) => call.method === "patch")).toBe(true);

        await expect(deniedHandler.handler(makeContext(denied, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        expect(denied.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("delete: predicate evaluates against the pre-write row", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "delete",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const database = createFakeDatabase([
            { _id: "mine", ownerId: "u1", table: "documents" },
            { _id: "theirs", ownerId: "u2", table: "documents" },
        ]);

        const allowedHandler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("mine"));
        const deniedHandler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("theirs"));

        await allowedHandler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "delete")).toBe(true);

        await expect(deniedHandler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("operator coverage: lt / in / contains / AND honored on writes", async () => {
        expect.assertions(5);

        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: () => {
                return {
                    AND: [{ priority: { lt: 5 } }, { status: { in: ["draft", "review"] } }, { title: { contains: "urgent" } }],
                };
            },
        });
        const database = createFakeDatabase([]);

        const handler = insertWithPolicy(policy);

        // Matches every branch — allowed.
        await handler({ priority: 3, status: "draft", title: "urgent fix" }).handler(makeContext(database, "u1"), {});

        expect(database.calls.filter((call) => call.method === "insert")).toHaveLength(1);

        // lt fails (5 is NOT less than 5).
        await expect(handler({ priority: 5, status: "draft", title: "urgent fix" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // in fails.
        await expect(handler({ priority: 1, status: "archived", title: "urgent" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // contains fails.
        await expect(handler({ priority: 1, status: "draft", title: "trivial" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });

        // null/undefined never matches an ordered comparator (SQL NULL
        // semantics) — `priority: null` with `lt: 5` denies.
        await expect(handler({ priority: null, status: "draft", title: "urgent" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
    });

    it("oR branch: any matching sub-predicate allows the write", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return {
                    OR: [{ ownerId: { eq: auth.userId } }, { visibility: { eq: "public" } }],
                };
            },
        });
        const database = createFakeDatabase([]);

        const handler = insertWithPolicy(policy);

        // OR-left matches (ownerId).
        await handler({ ownerId: "u1", visibility: "private" }).handler(makeContext(database, "u1"), {});

        // OR-right matches (public visibility — different owner).
        await handler({ ownerId: "u2", visibility: "public" }).handler(makeContext(database, "u1"), {});

        // Neither matches — denied.
        await expect(handler({ ownerId: "u2", visibility: "private" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
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
        const inertPolicy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => false,
        });

        expect(inertPolicy.table).toBe("documents");

        const database = createFakeDatabase([]);

        const handler = lunora.query.query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        const findManyCall = database.calls.find((call) => call.method === "findMany");

        // No baseWhere — the wrapper never ran.
        expect((findManyCall?.args as { baseWhere?: unknown } | undefined)?.baseWhere).toBeUndefined();
    });

    it("a LunoraError thrown from a policy denial carries status 403", async () => {
        expect.assertions(3);

        const policy = definePolicy<TestContext>({
            on: "delete",
            table: "documents",
            when: () => false,
        });
        const database = createFakeDatabase([{ _id: "d1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1"));

        const error = await handler.handler(makeContext(database, "u1"), {}).then(
            () => {
                throw new Error("expected to throw");
            },
            (error_: unknown) => error_,
        );

        expect(error).toBeInstanceOf(LunoraError);
        expect((error as LunoraError).status).toBe(403);
        expect((error as LunoraError).code).toBe("FORBIDDEN");
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

describe("definePolicies — duplicate detection", () => {
    it("throws when the same (table, on, when) policy is registered twice", () => {
        expect.assertions(2);

        const ownerOnly = definePolicy({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "u1" };
            },
        });

        let error: unknown;

        try {
            // The same policy object spread/listed twice — a copy-paste bug.
            definePolicies([ownerOnly, ownerOnly]);
        } catch (error_: unknown) {
            error = error_;
        }

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('duplicate policy for (table "documents", on "read")');
    });

    it("allows multiple DISTINCT policies on the same (table, on) — the OR/AND feature", () => {
        expect.assertions(1);

        const byOwner = definePolicy({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "u1" };
            },
        });
        const byTeam = definePolicy({
            on: "read",
            table: "documents",
            when: () => {
                return { teamId: "t1" };
            },
        });

        // Distinct `when` functions for the same (table, on) are legitimate.
        expect(() => definePolicies([byOwner, byTeam])).not.toThrow();
    });

    it("allows the same `when` reuse across different (table, on) keys", () => {
        expect.assertions(1);

        const tenantScope = (): { tenantId: string } => {
            return { tenantId: "t1" };
        };
        const readDocs = definePolicy({ on: "read", table: "documents", when: tenantScope });
        const readNotes = definePolicy({ on: "read", table: "notes", when: tenantScope });
        const updateDocs = definePolicy({ on: "update", table: "documents", when: tenantScope });

        expect(() => definePolicies([readDocs, readNotes, updateDocs])).not.toThrow();
    });
});

describe("rls — analytical reads (baseWhere on the full facade)", () => {
    const ownerPolicy = definePolicy<TestContext>({
        on: "read",
        table: "documents",
        when: ({ auth }) => {
            return { ownerId: auth.userId };
        },
    });

    it("and-merges the read baseWhere into aggregate()", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("documents", { op: "sum", where: { archived: false } }));

        await handler.handler(makeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "aggregate");

        expect(call?.args).toMatchObject({ baseWhere: { ownerId: "u1" }, op: "sum", where: { archived: false } });
    });

    it("and-merges the read baseWhere into groupBy()", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.groupBy("documents", { by: ["status"] }));

        await handler.handler(makeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "groupBy");

        expect(call?.args).toMatchObject({ baseWhere: { ownerId: "u1" }, by: ["status"] });
    });

    it("fails rank() closed with COUNT_RLS_UNSUPPORTED under a read policy", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("documents", "byScore", { row: "d1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "COUNT_RLS_UNSUPPORTED" });
        // The underlying writer is never reached — the guard throws first.
        expect(database.calls.some((entry) => entry.method === "rank")).toBe(false);
    });

    it("fails rankPage() closed with COUNT_RLS_UNSUPPORTED under a read policy", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("documents", "byScore"));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "COUNT_RLS_UNSUPPORTED" });
        expect(database.calls.some((entry) => entry.method === "rankPage")).toBe(false);
    });

    it("leaves analytical reads UNRESTRICTED on a table with no read policy", async () => {
        expect.assertions(3);

        // Policy targets "documents"; "events" carries none, so its analytical
        // reads pass through with no baseWhere and rank() doesn't throw.
        const database = createFakeDatabase([{ _id: "e1", table: "events" }]);
        const handler = lunora.query.use(rlsForTest<TestContext>([ownerPolicy])).query(async ({ ctx }) => {
            const typed = (ctx as unknown as TestContext).db;

            await typed.aggregate("events", { op: "sum" });

            return typed.rank("events", "byTime", { row: "e1" });
        });

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result).toEqual({ position: 1, total: 1 });

        const aggregateCall = database.calls.find((entry) => entry.method === "aggregate");

        expect((aggregateCall?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
        expect(database.calls.some((entry) => entry.method === "rank")).toBe(true);
    });
});

describe("rls — per-table facade + orm (no RLS bypass)", () => {
    const ownerPolicy = definePolicy<TestContext>({
        on: "read",
        table: "documents",
        when: ({ auth }) => {
            return { ownerId: auth.userId };
        },
    });

    /**
     * Glue a per-table facade (the `ctx.db.documents.findMany(...)` form) and
     * `ctx.orm` onto the fake writer, mirroring codegen's `bindTable`/`bindOrm`
     * — the exact shape the real runtime hands the middleware. This is what the
     * C1 regression test guards: `wrapDatabase` must re-bind these to route
     * through the RLS layer rather than the raw writer.
     */
    const withFacade = (database: FakeDatabase): FakeDatabase["writer"] & Record<string, unknown> => {
        const { writer } = database;
        const bindTable = (tableName: string): Record<string, unknown> => {
            return {
                aggregate: (options: unknown) => writer.aggregate(tableName, options),
                count: (where?: unknown) => writer.count(tableName, where),
                delete: (id: string) => writer.delete(id),
                findFirst: (args?: unknown) => writer.findFirst(tableName, args),
                findFirstOrThrow: (args?: unknown) => writer.findFirstOrThrow(tableName, args),
                findMany: (args?: unknown) => writer.findMany(tableName, args),
                get: (id: string) => writer.get(id),
                groupBy: (options: unknown) => writer.groupBy(tableName, options),
                insert: (document: Record<string, unknown>) => writer.insert(tableName, document),
                patch: (id: string, patch: Record<string, unknown>) => writer.patch(id, patch),
                rank: (indexName: string, options: unknown) => writer.rank(tableName, indexName, options),
                rankPage: (indexName: string, options?: unknown) => writer.rankPage(tableName, indexName, options),
                replace: (id: string, document: Record<string, unknown>) => writer.replace(id, document),
                // Stub so `isFacadeEntry` recognises this as a table accessor.
                withSearchIndex: () => {
                    throw new Error("withSearchIndex not used in these tests");
                },
            };
        };

        const db = writer as FakeDatabase["writer"] & Record<string, unknown>;

        db["documents"] = bindTable("documents");
        // A non-policy table (stands in for a `.global()` entry bound to the D1
        // writer): the RLS rebind must leave it untouched, or it would re-route
        // to the wrong backend.
        db["events"] = bindTable("events");

        return db;
    };

    const makeFacadeContext = (database: FakeDatabase, userId: null | string): Record<string, unknown> => {
        const db = withFacade(database);
        const resolve = (table: string): Record<string, unknown> => db[table] as Record<string, unknown>;

        return {
            auth: { roles: [], userId },
            db,
            orm: {
                delete: (table: string, id: string) => (resolve(table)["delete"] as (id: string) => unknown)(id),
                insert: (table: string) => {
                    return { values: (values: Record<string, unknown>) => (resolve(table)["insert"] as (v: Record<string, unknown>) => unknown)(values) };
                },
                query: db,
                replace: (table: string, id: string) => {
                    return {
                        with: (values: Record<string, unknown>) =>
                            (resolve(table)["replace"] as (id: string, v: Record<string, unknown>) => unknown)(id, values),
                    };
                },
                update: (table: string, id: string) => {
                    return {
                        set: (values: Record<string, unknown>) => (resolve(table)["patch"] as (id: string, v: Record<string, unknown>) => unknown)(id, values),
                    };
                },
            },
        };
    };

    interface FacadeCtx {
        db: Record<
            string,
            { count: (where?: unknown) => Promise<number>; findMany: (args?: unknown) => Promise<unknown>; get: (id: string) => Promise<unknown> }
        >;
        orm: { query: Record<string, { findMany: (args?: unknown) => Promise<unknown> }> };
    }

    it("injects baseWhere into ctx.db.<table>.findMany() (the facade is not a bypass)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as FacadeCtx).db["documents"]!.findMany({ where: { archived: false } }));

        await handler.handler(makeFacadeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "findMany");

        expect(call?.args).toMatchObject({ baseWhere: { ownerId: "u1" }, where: { archived: false } });
    });

    it("injects baseWhere into ctx.orm.query.<table>.findMany()", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as FacadeCtx).orm.query["documents"]!.findMany());

        await handler.handler(makeFacadeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "findMany");

        expect((call?.args as { baseWhere?: unknown }).baseWhere).toEqual({ ownerId: "u1" });
    });

    it("propagates restrictsCounts through ctx.db.<table>.count()", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as FacadeCtx).db["documents"]!.count());

        await handler.handler(makeFacadeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "count");

        expect((call?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(true);
    });

    it("does NOT leak a denied row through ctx.db.<table>.get()", async () => {
        expect.assertions(1);

        // Row owned by u2; policy for u1 denies it. The fake findFirst honours
        // baseWhere (returns null when the row fails the predicate).
        const database = createFakeDatabase([{ _id: "d2", ownerId: "u2", table: "documents" }]);

        // Honour baseWhere in the fake's findFirst, mirroring @lunora/do.
        const originalFindFirst = database.writer.findFirst.bind(database.writer);

        database.writer.findFirst = async (tableName, args) => {
            const row = await originalFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: string } } | undefined)?.baseWhere;

            if (row && baseWhere?.ownerId !== undefined && row["ownerId"] !== baseWhere.ownerId) {
                return null;
            }

            return row;
        };

        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as FacadeCtx).db["documents"]!.get("d2"));

        const result = await handler.handler(makeFacadeContext(database, "u1"), {});

        expect(result).toBeNull();
    });

    it("leaves a non-policy table's facade entry on its original binding (no backend re-route)", async () => {
        expect.assertions(2);

        // `documents` has a policy → its facade entry is re-bound through RLS;
        // `events` has none (it stands in for a `.global()` table) → its entry
        // must stay the exact object the runtime glued on, so it keeps routing
        // to its own backend rather than the local wrapped writer.
        const database = createFakeDatabase([]);

        let documentsEntry: unknown;
        let eventsEntry: unknown;

        const handler = lunora.query.use(rlsForTest<TestContext>([ownerPolicy])).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, unknown> };

            documentsEntry = db["documents"];
            eventsEntry = db["events"];

            return null;
        });

        const context = makeFacadeContext(database, "u1");
        const originalEvents = (context["db"] as Record<string, unknown>)["events"];
        const originalDocuments = (context["db"] as Record<string, unknown>)["documents"];

        await handler.handler(context, {});

        // events: identical reference (untouched); documents: re-bound (replaced).
        expect(eventsEntry).toBe(originalEvents);
        expect(documentsEntry).not.toBe(originalDocuments);
    });
});

describe("rls — permissions / can()", () => {
    const deletePosts = definePermission("posts:delete");
    const editor = defineRole("editor", { permissions: [deletePosts] });

    // A write policy gated on a permission rather than a raw role string.
    const policy = definePolicy<TestContext>({
        on: "insert",
        table: "documents",
        when: ({ auth }) => auth.can(deletePosts),
    });

    // Like `rlsForTest`, but threads the role→permission grants into the middleware.
    const rlsWithRoles = (roles: ReadonlyArray<Role>): Middleware<any, any> =>
        (rls as unknown as (p: ReadonlyArray<Policy<TestContext>>, options: { roles: ReadonlyArray<Role> }) => Middleware<any, any>)([policy], { roles });

    const insertHandler = (roles: ReadonlyArray<Role>) =>
        lunora.mutation.use(rlsWithRoles(roles)).mutation(async ({ ctx }) => ctx.db.insert("documents", { _id: "x" }));

    it("allows the write when a request role grants the permission", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);

        await insertHandler([editor]).handler(makeContext(database, "u1", ["editor"]), {});

        expect(database.calls.some((call) => call.method === "insert")).toBe(true);
    });

    it("denies the write when no request role grants the permission", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);

        await expect(insertHandler([editor]).handler(makeContext(database, "u1", ["viewer"]), {})).rejects.toThrow(LunoraError);
    });

    it("fails closed for a granting role the middleware wasn't told about", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);

        // The request carries "editor", but `rls()` got no roles — `can()` can't
        // resolve the grant, so the permission check is false and the write denies.
        await expect(insertHandler([]).handler(makeContext(database, "u1", ["editor"]), {})).rejects.toThrow(LunoraError);
    });

    it("accepts a permission checked by its bare name", async () => {
        expect.assertions(1);

        const namedPolicy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => auth.can("posts:delete"),
        });
        const database = createFakeDatabase([]);
        const handler = lunora.mutation
            .use(
                (rls as unknown as (p: ReadonlyArray<Policy<TestContext>>, options: { roles: ReadonlyArray<Role> }) => Middleware<any, any>)([namedPolicy], {
                    roles: [editor],
                }),
            )
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { _id: "y" }));

        await handler.handler(makeContext(database, "u1", ["editor"]), {});

        expect(database.calls.some((call) => call.method === "insert")).toBe(true);
    });
});
