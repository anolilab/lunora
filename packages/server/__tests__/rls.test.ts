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

import type { FacadeWriterLike } from "../src/facade";
import { bindTableFacade } from "../src/facade";
import type { Middleware, Policy, Role } from "../src/index";
import { definePermission, definePolicies, definePolicy, defineRole, initLunora, LunoraError, rls } from "../src/index";

/**
 * The procedure builder types `ctx.db` nominally (`DatabaseReader`/
 * `DatabaseWriter`); the RLS middleware's structural `DatabaseWriterLike`
 * shape is a superset (it also accepts the new `baseWhere` /
 * `restrictsCounts` count signature) so TS rejects the direct widening.
 * Pin a permissive cast once here so each test reads cleanly without
 * scattering `as unknown as Middleware<…>` at every call site.
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
    verify?: (previous: Record<string, unknown>, next: Record<string, unknown>) => boolean;
}

interface FakeDatabase {
    calls: CapturedCall[];
    writer: {
        aggregate: (tableName: string, options: unknown) => Promise<null | number>;
        count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
        delete: (id: string, expectedTable?: string, options?: { hard?: boolean }) => Promise<void>;
        deleteMany: (ids: ReadonlyArray<string>, options?: { limit?: number }) => Promise<{ deleted: number }>;
        deleteWhere: (tableName: string, args: { limit?: number; where: Record<string, unknown> }) => Promise<{ deleted: number }>;
        explain: (tableName: string, args?: unknown) => Promise<{ params: unknown[]; plan: string[]; sql: string }>;
        findFirst: (tableName: string, args?: unknown) => Promise<Record<string, unknown> | null>;
        findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        get: (table: string, id: string) => Promise<Record<string, unknown> | null>;
        groupBy: (tableName: string, options: unknown) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
        insert: (tableName: string, document: Record<string, unknown>, options?: { clientId?: string }) => Promise<string>;
        insertMany: (
            tableName: string,
            documents: ReadonlyArray<Record<string, unknown>>,
            options?: { limit?: number; skipDuplicates?: boolean },
        ) => Promise<(string | null)[]>;
        insertManyUnsafe: (
            tableName: string,
            documents: ReadonlyArray<Record<string, unknown>>,
            options?: { allowExplicitId?: boolean; limit?: number },
        ) => Promise<string[]>;
        /** The fake writer stands in for a mutation's writer by default (inside a transaction); override per-test for an action. */
        inTransaction?: () => boolean;
        lookupById?: (id: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
        patch: (id: string, patch: Record<string, unknown>, expectedTable?: string, options?: { verify?: CapturedCall["verify"] }) => Promise<void>;
        patchIf: (
            tableName: string,
            id: string,
            args: { patch: Record<string, unknown>; where: Record<string, unknown> },
        ) => Promise<{ applied: boolean; doc: Record<string, unknown> | null }>;
        patchMany: (patches: ReadonlyArray<{ id: string; patch: Record<string, unknown> }>, options?: { limit?: number }) => Promise<{ patched: number }>;
        patchWhere: (
            tableName: string,
            args: { limit?: number; patch: Record<string, unknown>; where: Record<string, unknown> },
        ) => Promise<{ patched: number }>;
        query: (tableName: string) => never;
        rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
        rankBefore: (tableName: string, indexName: string, options: unknown) => Promise<{ before: number; total: number }>;
        rankPage: (
            tableName: string,
            indexName: string,
            options?: unknown,
        ) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        /** Optional — mirrors `@lunora/shard-engine`'s cross-shard companion to `rankPage`. Enabled per-test via `enableRankPageRows`. */
        rankPageRows?: (
            tableName: string,
            indexName: string,
            options?: unknown,
        ) => Promise<{
            directions: ReadonlyArray<"asc" | "desc">;
            hasMore: boolean;
            rows: ReadonlyArray<{ doc: Record<string, unknown>; key: { partitionKey: string; rowId: string; sortValues: ReadonlyArray<unknown> } }>;
        }>;
        replace: (id: string, document: Record<string, unknown>) => Promise<void>;
        restore: (id: string, expectedTable?: string) => Promise<void>;
        /** Enable per-test to model a `.softDelete()` table: table → marker column. */
        softDeleteFields?: ReadonlyMap<string, string>;
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
            async delete(id, _expectedTable, options) {
                calls.push({ args: options, method: "delete", tableOrId: id });
            },
            async deleteMany(ids) {
                calls.push({ args: ids, method: "deleteMany", tableOrId: "" });

                return { deleted: ids.length };
            },
            async deleteWhere(tableName, args) {
                calls.push({ args, method: "deleteWhere", tableOrId: tableName });

                return { deleted: rowsOfTable(tableName).length };
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
            async explain(tableName, args) {
                calls.push({ args, method: "explain", tableOrId: tableName });

                return { params: [], plan: [], sql: "" };
            },
            async findMany(tableName, args) {
                calls.push({ args, method: "findMany", tableOrId: tableName });

                return { continueCursor: null, isDone: true, page: rowsOfTable(tableName) };
            },
            async get(_table, id) {
                calls.push({ args: undefined, method: "get", tableOrId: id });

                return byId.get(id) ?? null;
            },
            async groupBy(tableName, options) {
                calls.push({ args: options, method: "groupBy", tableOrId: tableName });

                return [{ key: {}, value: rowsOfTable(tableName).length }];
            },
            // The fake models a mutation's writer by default; an action test overrides this to `() => false`.
            inTransaction: () => true,
            async insert(tableName, document, options) {
                calls.push({ args: options === undefined ? document : { document, options }, method: "insert", tableOrId: tableName });

                return options?.clientId ?? (document["_id"] as string | undefined) ?? "new-id";
            },
            async insertMany(tableName, documents, options) {
                calls.push({ args: documents, method: "insertMany", tableOrId: tableName });

                return documents.map((document, index) => {
                    if (options?.skipDuplicates === true && index === 0 && document["_id"] === "dup") {
                        return null;
                    }

                    return (document["_id"] as string | undefined) ?? `new-id-${String(index)}`;
                });
            },
            async insertManyUnsafe(tableName, documents) {
                calls.push({ args: documents, method: "insertManyUnsafe", tableOrId: tableName });

                return documents.map((document, index) => (document["_id"] as string | undefined) ?? `new-id-${String(index)}`);
            },
            async patch(id, patchValue, _expectedTable, writeOptions) {
                calls.push({ args: patchValue, method: "patch", tableOrId: id, verify: writeOptions?.verify });
            },
            async patchIf(tableName, id, args) {
                calls.push({ args, method: "patchIf", tableOrId: id });

                return { applied: true, doc: { _id: id, table: tableName, ...args.patch } };
            },
            async patchMany(patches) {
                calls.push({ args: patches, method: "patchMany", tableOrId: "" });

                return { patched: patches.length };
            },
            async patchWhere(tableName, args) {
                calls.push({ args, method: "patchWhere", tableOrId: tableName });

                return { patched: rowsOfTable(tableName).length };
            },
            query() {
                throw new Error("query() not used in these tests");
            },
            async restore(id) {
                calls.push({ args: undefined, method: "restore", tableOrId: id });
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
 * Enable the optional `lookupById` fast-path seam on a fake writer, answering
 * `{ row, tableName }` from the seeded rows in one shot — mirroring what
 * `@lunora/do`'s `lookupById` returns. Records a `lookupById` call so a test
 * can assert the probe fan-out (`findFirst` per policy table) was skipped.
 */
const enableGetWithTable = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    const byId = new Map(rows.map((row) => [row._id, row] as const));

    // eslint-disable-next-line no-param-reassign -- the helper's purpose is to install the seam on the caller's fake writer
    database.writer.lookupById = async (id) => {
        database.calls.push({ args: undefined, method: "lookupById", tableOrId: id });
        const row = byId.get(id);

        return row ? { row, tableName: row.table } : null;
    };
};

/** Enable the optional `rankPageRows` seam — the cross-shard companion to `rankPage` (mirrors `@lunora/shard-engine`'s writer). */
const enableRankPageRows = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    // eslint-disable-next-line no-param-reassign -- the helper's purpose is to install the seam on the caller's fake writer
    database.writer.rankPageRows = async (tableName, _indexName, options) => {
        database.calls.push({ args: options, method: "rankPageRows", tableOrId: tableName });

        return {
            directions: ["asc"],
            hasMore: false,
            rows: rows
                .filter((row) => row.table === tableName)
                .map((row, index) => {
                    return { doc: row, key: { partitionKey: "", rowId: row._id, sortValues: [index] } };
                }),
        };
    };
};

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface TestContext {
    auth: { getIdentity?: () => Promise<Record<string, unknown> | null>; userId: null | string };
    db: FakeDatabase["writer"];
}

// Roles reach a policy only as the `roles` claim on the resolved identity —
// the same single source `resolvePolicyAuth` reads at request time.
const makeContext = (database: FakeDatabase, userId: null | string, roles: string[] = []): TestContext => {
    return {
        auth: {
            getIdentity: async () => {
                return { roles, userId };
            },
            userId,
        },
        db: database.writer,
    };
};

/** Build a one-off insert handler running through an `rls()` chain over a single policy. */
const insertWithPolicy = (policy: Policy<TestContext>) => (document: Record<string, unknown>) =>
    lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.insert("documents", document));

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

/** Runs `patch("a1", …)` through the RLS middleware as user `u1`, against `database`. */
const patchAccount = (policy: ReturnType<typeof definePolicy<TestContext>>, database: FakeDatabase) => async (patch: Record<string, unknown>) =>
    lunora.mutation
        .use(rlsForTest<TestContext>([policy]))
        .mutation(async ({ ctx }) => ctx.db.patch("a1", patch))
        .handler(makeContext(database, "u1"), {});

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

    it("merges the read policy into explain, so the plan is the one this caller's read gets", async () => {
        expect.assertions(1);

        const policies = definePolicies([
            definePolicy<TestContext>({
                on: "read",
                table: "documents",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
        ]);
        const database = createFakeDatabase([]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>(policies))
            .query(async ({ ctx }) => ctx.db.explain("documents", { where: { archived: false } }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.find((call) => call.method === "explain")?.args).toMatchObject({
            baseWhere: { ownerId: "u1" },
            where: { archived: false },
        });
    });

    it("attaches a relationBaseWhere resolving a child table's read policy (relation RLS)", async () => {
        expect.assertions(2);

        // A read policy on the CHILD table (`messages`), loaded via `with`.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "messages",
            when: ({ auth }) => {
                return { authorId: auth.userId };
            },
        });
        const policies = definePolicies([policy]);
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>(policies)).query(async ({ ctx }) => ctx.db.findMany("users", { with: { messages: true } }));

        await handler.handler(makeContext(database, "u1"), {});

        const findManyCall = database.calls.find((call) => call.method === "findMany");
        const provider = (findManyCall?.args as { relationBaseWhere?: (table: string) => unknown }).relationBaseWhere;

        // The wrapper forwards a provider that yields the child's read baseWhere
        // (so @lunora/do filters the `messages` relation hop) and `undefined`
        // for a table with no restricting policy.
        expect(provider?.("messages")).toEqual({ authorId: "u1" });
        expect(provider?.("users")).toBeUndefined();
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

    // SECURITY (regression): the mirror of the test above, and the reason a dead
    // `auth.roles` is a vulnerability rather than a papercut. The generated
    // context is `auth: { getIdentity, userId }` — there has never been a
    // `ctx.auth.roles` for anything to populate — so a policy whose DENY branch
    // is gated on a role read `[]`, never took the branch, and left a suspended
    // caller with the same access as everyone else. Roles are now read off the
    // resolved identity's `roles` claim, the one place the runtime produces them.
    it("a role-gated DENY branch fires for a suspended caller", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("suspended") ? false : { ownerId: auth.userId }),
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(makeContext(database, "u1", ["suspended"]), {});

        // `{ OR: [] }` is the vacuously-false sentinel: zero rows survive.
        expect((database.calls.at(-1)?.args as { baseWhere?: unknown }).baseWhere).toEqual({ OR: [] });

        // …while an unsuspended caller keeps their own rows.
        await handler.handler(makeContext(database, "u2", []), {});

        expect((database.calls.at(-1)?.args as { baseWhere?: unknown }).baseWhere).toEqual({ ownerId: "u2" });
    });

    // better-auth's `admin()` plugin stores a multi-role value comma-joined, so a
    // resolver forwarding that column verbatim must not silently resolve to no
    // roles — that is the same fail-open the dead `auth.roles` produced.
    it("reads a comma-separated `roles` claim as a role list", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("admin") ? true : { ownerId: auth.userId }),
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(
            {
                auth: {
                    getIdentity: async () => {
                        return { roles: "user,admin" };
                    },
                    userId: "u1",
                },
                db: database.writer,
            },
            {},
        );

        expect((database.calls.at(-1)?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    // A middleware may derive roles a provider's envelope does not carry as a
    // `roles` claim and hand them over as `ctx.auth.roles`. Reading only the
    // claim on the request path silently drops every such role, and a role-gated
    // DENY branch that stops firing LEAKS rows. (Live shapes see the claim only
    // — see the KNOWN DIVERGENCE in `src/rls/shape-read-base.ts`.)
    it("honours roles contributed by an upstream middleware, not just the identity claim", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("admin") ? true : { ownerId: auth.userId }),
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(
            {
                auth: {
                    // No `roles` claim on the identity — exactly the Access shape.
                    getIdentity: async () => {
                        return { email: "ada@example.com" };
                    },
                    roles: ["admin"],
                    userId: "u1",
                },
                db: database.writer,
            },
            {},
        );

        expect((database.calls.at(-1)?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    it("unions middleware roles with the identity claim rather than letting one win", async () => {
        expect.assertions(1);

        // Two producers, one role each, and a policy that needs both. Either
        // source alone leaves the caller short, so this fails if the resolution
        // picks a winner instead of merging.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => (auth.roles.includes("admin") && auth.roles.includes("auditor") ? true : { ownerId: auth.userId }),
        });
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.findMany("documents"));

        await handler.handler(
            {
                auth: {
                    getIdentity: async () => {
                        return { roles: ["auditor"] };
                    },
                    roles: ["admin"],
                    userId: "u1",
                },
                db: database.writer,
            },
            {},
        );

        expect((database.calls.at(-1)?.args as { baseWhere?: unknown }).baseWhere).toBeUndefined();
    });

    it("count() throws COUNT_RLS_UNSUPPORTED when a policy narrows the table", async () => {
        expect.hasAssertions();

        // We can't observe the underlying LunoraError here without wiring the
        // fake DB to honor `restrictsCounts`. Instead we assert the wrapper
        // *passes* `restrictsCounts: true` down to the writer — the ORM is
        // responsible for converting that into the thrown LunoraError, and
        // we assert that in the ORM tests below.
        //
        // The policy has to NARROW for the flag to be set; an allow-all read
        // policy leaves the count exactly computable and is asserted separately.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "u1" };
            },
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

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("documents", "d1"));

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

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("audit", "a1"));

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

        const denied = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("documents", "d1"));
        const allowed = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("notes", "n1"));
        const absent = lunora.query.use(rlsForTest<TestContext>([docsPolicy, notesPolicy])).query(async ({ ctx }) => ctx.db.get("documents", "missing"));

        // d1 exists in "documents" but is denied → null (NOT the leaked row).
        await expect(denied.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
        // n1 exists in "notes" and is owned by u1 → returned.
        await expect(allowed.handler(makeContext(fake, "u1"), {})).resolves.toMatchObject({ _id: "n1" });
        // missing id → null.
        await expect(absent.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
    });

    it("get() uses the lookupById fast path and skips the probe fan-out when present", async () => {
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

        // Owned + allowed: single lookupById lookup + one policy-check findFirst.
        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => ctx.db.get("documents", "d1"));
        const result = await handler.handler(makeContext(fake, "u1"), {});

        expect(result?.["_id"]).toBe("d1");
        expect(fake.calls.some((call) => call.method === "lookupById")).toBe(true);

        // No membership probe fan-out: the only findFirst is the policy check on
        // the owning table (with a baseWhere), never an unscoped probe.
        const unscopedProbes = fake.calls.filter((call) => call.method === "findFirst" && !(call.args as { baseWhere?: unknown } | undefined)?.baseWhere);

        expect(unscopedProbes).toHaveLength(0);
    });

    it("lookupById() resolves null (not the row) when the read policy denies it (plan 254)", async () => {
        expect.assertions(1);

        // Same shape as "get() does NOT leak a row that the read policy
        // denied" above, but calling the `lookupById` seam directly — the
        // `...base` spread in `rls/middleware.ts` would otherwise expose
        // `base.lookupById` (the RLS-guarded, but not policy-filtered, seam)
        // unfiltered by the read policy, leaking another user's row.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        const rows = [{ _id: "d1", ownerId: "u2", table: "documents" }];
        const fake = createFakeDatabase(rows);

        enableGetWithTable(fake, rows);

        // Honest fake: a baseWhere-scoped findFirst filters by the predicate,
        // mirroring what `@lunora/do`'s `findFirst` does at runtime (the
        // default fake ignores `baseWhere` entirely).
        const wrappedFindFirst = fake.writer.findFirst;

        fake.writer.findFirst = async (tableName, args) => {
            const candidate = await wrappedFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: unknown } } | undefined)?.baseWhere;

            if (!candidate || !baseWhere || !("ownerId" in baseWhere)) {
                return candidate;
            }

            return candidate["ownerId"] === baseWhere.ownerId ? candidate : null;
        };

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("d1"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
    });

    it("lookupById() returns { row, tableName } when the read policy grants access (plan 254)", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });

        const rows = [{ _id: "d1", ownerId: "u1", table: "documents" }];
        const fake = createFakeDatabase(rows);

        enableGetWithTable(fake, rows);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("d1"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).resolves.toMatchObject({ row: { _id: "d1" }, tableName: "documents" });
    });

    it("lookupById() on an id outside every policy-gated table passes through unrestricted (plan 254)", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => {
                return { ownerId: "anyone" };
            },
        });

        const rows = [{ _id: "a1", event: "login", table: "audit" }];
        const fake = createFakeDatabase(rows);

        enableGetWithTable(fake, rows);

        const handler = lunora.query.use(rlsForTest<TestContext>([policy])).query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("a1"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).resolves.toMatchObject({ row: { _id: "a1" }, tableName: "audit" });
    });

    it("lookupById() on an unresolvable (e.g. global) id returns null rather than throwing (plan 254)", async () => {
        expect.assertions(1);

        // Mirrors `@lunora/shard-engine`'s own contract: a global row's table
        // isn't resolvable by the shard-local seam, so it returns `null` and
        // the caller keeps its probe fallback — the gate must not turn this
        // into a thrown error.
        const policy = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => true,
        });

        const rows: (Record<string, unknown> & { _id: string; table: string })[] = [];
        const fake = createFakeDatabase(rows);

        enableGetWithTable(fake, rows);

        const handler = lunora.query
            .use(rlsForTest<TestContext>([policy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("unresolvable-id"));

        await expect(handler.handler(makeContext(fake, "u1"), {})).resolves.toBeNull();
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

    it("count() treats a legacy WhereInput naming reserved-looking columns as a predicate, not options", async () => {
        expect.assertions(2);

        // A user table with a column literally named `where` (and another
        // reserved-looking key with a scalar value). The legacy
        // `count(table, whereInput)` signature must keep working — the bag must
        // NOT be mistaken for a `CountArgs` options object and dropped.
        const predicate = { restrictsCounts: "yes", where: "draft" };

        const database = createFakeDatabase([]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([]))
            .query(async ({ ctx }) => ctx.db.count("documents", predicate as unknown as Record<string, unknown>));

        await handler.handler(makeContext(database, "u1"), {});

        const countCall = database.calls.find((call) => call.method === "count");

        // The whole predicate is forwarded under `where`; `restrictsCounts`
        // stays the boolean false the wrapper computes, not the column's "yes".
        expect((countCall?.args as { where?: unknown }).where).toEqual(predicate);
        expect((countCall?.args as { restrictsCounts?: unknown }).restrictsCounts).toBe(false);
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

    it("gates each child of a nested relation write by that child's own update policy", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([
            { _id: "f1", table: "folders" },
            { _id: "d1", ownerId: "u2", table: "documents" },
        ]);

        (database.writer as unknown as Record<string, unknown>)["relationWrites"] = {
            folders: { documents: { colocated: true, field: "folderId", kind: "many", nullable: true, references: "_id", table: "documents" } },
        };

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => bindTableFacade(ctx.db as unknown as FacadeWriterLike, "folders").patch("f1", { documents: { connect: ["d1"] } }));

        // The caller may read the document but not update it, so pointing it at the folder is refused.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    /** A folder with one document, and the relation-only patch that attaches the document to it. */
    const relationOnlyFolderPatch = (folderOwner: string, documentOwner: string) => {
        const folderPolicy = definePolicy<TestContext>({
            on: "update",
            table: "folders",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const documentPolicy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([
            { _id: "f1", ownerId: folderOwner, table: "folders" },
            { _id: "d1", ownerId: documentOwner, table: "documents" },
        ]);

        (database.writer as unknown as Record<string, unknown>)["relationWrites"] = {
            folders: { documents: { colocated: true, field: "folderId", kind: "many", nullable: true, references: "_id", table: "documents" } },
        };

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([folderPolicy, documentPolicy]))
            .mutation(async ({ ctx }) => bindTableFacade(ctx.db as unknown as FacadeWriterLike, "folders").patch("f1", { documents: { connect: ["d1"] } }));

        return { database, handler };
    };

    it("denies a relation-only patch whose parent the caller may read but not update, before any child is written", async () => {
        expect.assertions(2);

        const { database, handler } = relationOnlyFolderPatch("u2", "u1");

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("still gates each child when the parent's update policy allows the relation-only patch", async () => {
        expect.assertions(2);

        const { database, handler } = relationOnlyFolderPatch("u1", "u2");

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("writes the child of a relation-only patch once both the parent and the child allow it", async () => {
        expect.assertions(2);

        const { database, handler } = relationOnlyFolderPatch("u1", "u1");

        await handler.handler(makeContext(database, "u1"), {});

        const patches = database.calls.filter((call) => call.method === "patch");

        expect(patches.map((call) => call.tableOrId)).toStrictEqual(["d1"]);
        expect(patches[0]?.args).toStrictEqual({ folderId: "f1" });
    });

    it.each([
        ["a policy table", "documents"],
        ["a table without policies", "notes"],
    ])("forwards a pinned clientId on insert into %s", async (_label, table) => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({ on: "insert", table: "documents", when: () => true });
        const database = createFakeDatabase([]);
        const clientId = "8d3f2a52-6a59-8c4e-9f1e-0b7c2d4e6f80";

        const id = await lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert(table, { title: "t" }, { clientId }))
            .handler(makeContext(database, "u1"), {});

        expect(id).toBe(clientId);
        expect(database.calls.find((call) => call.method === "insert")?.args).toStrictEqual({ document: { title: "t" }, options: { clientId } });
    });

    it("update policy denies a conditional patch with FORBIDDEN before it reaches the writer", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.patchIf("documents", "d1", { patch: { title: "new" }, where: { title: "old" } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });

        expect(database.calls.some((call) => call.method === "patchIf")).toBe(false);
    });

    it("update policy checks a conditional patch's post-image and forwards it when allowed", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const run = async (patch: Record<string, unknown>) =>
            lunora.mutation
                .use(rlsForTest<TestContext>([policy]))
                .mutation(async ({ ctx }) => ctx.db.patchIf("documents", "d1", { patch, where: { ownerId: "u1" } }))
                .handler(makeContext(database, "u1"), {});

        await expect(run({ ownerId: "u2" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(run({ title: "new" })).resolves.toMatchObject({ applied: true });
    });

    it("withholds a conditional patch's row from a caller the read policy hides it from", async () => {
        expect.assertions(2);

        const policies = definePolicies([
            definePolicy<TestContext>({ on: "update", table: "documents", when: () => true }),
            definePolicy<TestContext>({
                on: "read",
                table: "documents",
                when: ({ auth }) => {
                    return { ownerId: auth.userId };
                },
            }),
        ]);
        const fake = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);
        const wrappedFindFirst = fake.writer.findFirst;

        // The fake ignores `baseWhere`; honour the owner scope so the read policy bites.
        fake.writer.findFirst = async (tableName, args) => {
            const candidate = await wrappedFindFirst(tableName, args);
            const baseWhere = (args as { baseWhere?: { ownerId?: unknown } } | undefined)?.baseWhere;

            return candidate && baseWhere && "ownerId" in baseWhere && candidate["ownerId"] !== baseWhere.ownerId ? null : candidate;
        };

        const run = async (userId: string) =>
            lunora.mutation
                .use(rlsForTest<TestContext>(policies))
                .mutation(async ({ ctx }) => ctx.db.patchIf("documents", "d1", { patch: { title: "new" }, where: {} }))
                .handler(makeContext(fake, userId), {});

        await expect(run("u1")).resolves.toStrictEqual({ applied: true, doc: null });
        await expect(run("u2")).resolves.toStrictEqual({ applied: true, doc: expect.objectContaining({ _id: "d1" }) });
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

    it("checks an atomic operator's resolved value, not the operator object, against the update policy", async () => {
        expect.assertions(7);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "accounts",
            when: ({ row }) => typeof row?.["balance"] === "number" && row["balance"] >= 0,
        });
        const database = createFakeDatabase([{ _id: "a1", balance: 3, table: "accounts" }]);
        const run = patchAccount(policy, database);

        // 3 - 1 = 2 keeps the post-image valid; 3 - 5 = -2 does not.
        await expect(run({ balance: { decrement: 1 } })).resolves.toBeUndefined();
        await expect(run({ balance: { decrement: 5 } })).rejects.toMatchObject({ code: "FORBIDDEN" });

        await run({ balance: 9 });

        // The store, not the gate, performs the arithmetic: the operator is forwarded untouched, with a
        // verdict the store takes on the row IT reads (it may differ from the gate's, and may retry).
        const [operatorCall, plainCall] = database.calls.filter((call) => call.method === "patch");

        expect(database.calls.filter((call) => call.method === "patch")).toHaveLength(2);
        // Every update through the gate carries the verdict, a plain patch included: the row the store reads can
        // differ from the one the gate read, whatever the patch holds.
        expect(plainCall?.verify).toBeTypeOf("function");
        expect(operatorCall?.verify?.({ balance: 3 }, { balance: 2 })).toBe(true);
        expect(operatorCall?.verify?.({ balance: 1 }, { balance: -4 })).toBe(false);
        expect(operatorCall?.verify?.({ balance: 3 }, { balance: "x" })).toBe(false);
    });

    it("checks the merged post-image of a path patch, and hands the store a verdict for it", async () => {
        expect.assertions(4);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "accounts",
            when: ({ row }) => (row?.["profile"] as { plan?: string } | undefined)?.plan !== "banned",
        });
        const database = createFakeDatabase([{ _id: "a1", profile: { age: 3, plan: "pro" }, table: "accounts" }]);
        const run = patchAccount(policy, database);

        // The post-image is `{ age: 3, plan: "banned" }`: the policy refuses it, though no column was named.
        await expect(run({ "profile.plan": "banned" })).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(run({ "profile.plan": "team" })).resolves.toBeUndefined();

        const call = database.calls.find((entry) => entry.method === "patch");

        expect(call?.args).toStrictEqual({ "profile.plan": "team" });
        // The store takes the verdict on the row IT reads: a path patch is merged into whatever the column holds then.
        expect(call?.verify?.({ profile: { plan: "pro" } }, { profile: { plan: "banned" } })).toBe(false);
    });

    it("boolean update policy denies a patch that reassigns the policy column (WITH-CHECK post-image)", async () => {
        expect.assertions(2);

        // Classic ownership policy: `row.ownerId === userId`. The pre-image is
        // owned by u1 (USING passes), but the patch hands the row to u2 — the
        // post-image must be denied or u1 could give away rows.
        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.patch("d1", { ownerId: "u2" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });

        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("boolean update policy denies a replace that reassigns the policy column (WITH-CHECK post-image)", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.replace("d1", { ownerId: "u2", title: "x" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });

        expect(database.calls.some((call) => call.method === "replace")).toBe(false);
    });

    it("boolean update policy allows a patch that keeps the row inside the policy", async () => {
        expect.assertions(2);

        // Pre- and post-image both owned by u1 — a legitimate field edit that
        // doesn't move the row must still pass (no double-deny).
        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.patch("d1", { ownerId: "u1", title: "renamed" }));

        await handler.handler(makeContext(database, "u1"), {});

        const patchCall = database.calls.find((call) => call.method === "patch");

        expect(patchCall).toBeDefined();
        expect(patchCall?.args).toMatchObject({ ownerId: "u1", title: "renamed" });
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

    it("compares a Date-valued predicate by equality instead of matching every row", async () => {
        expect.assertions(2);

        // A `Date` (like a `Uint8Array` or a `Map`) has no own enumerable keys.
        // Under a `typeof value === "object"` plain-object test it counted as an
        // operator bag, `every` over zero keys was vacuously true, and the
        // predicate matched EVERY candidate row — so this policy allowed an
        // insert carrying any `createdAt` at all.
        const cutoff = new Date("2024-01-01T00:00:00.000Z");
        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: () => {
                return { createdAt: cutoff };
            },
        });
        const database = createFakeDatabase([]);
        const insert = insertWithPolicy(policy);

        // A different instant must be denied…
        await expect(insert({ createdAt: new Date("2025-06-01T00:00:00.000Z"), title: "x" }).handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
        });
        // …and the matching value must still be allowed (equality, not "deny all").
        await expect(insert({ createdAt: cutoff, title: "x" }).handler(makeContext(database, "u1"), {})).resolves.toBeDefined();
    });
});

describe("rls — batch write path", () => {
    const ownerPolicy = definePolicy<TestContext>({
        on: "insert",
        table: "documents",
        when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
    });

    it("insertMany routes every authorized row through the writer batch", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([ownerPolicy])).mutation(async ({ ctx }) =>
            ctx.db.insertMany("documents", [
                { ownerId: "u1", title: "a" },
                { ownerId: "u1", title: "b" },
            ]),
        );

        const ids = await handler.handler(makeContext(database, "u1"), {});

        expect(ids).toHaveLength(2);
        // The whole batch went through one delegated `insertMany`, not per-row inserts.
        expect(database.calls.some((call) => call.method === "insertMany")).toBe(true);
    });

    it("insertMany denies the whole batch (FORBIDDEN) when one row fails its policy, before any write", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([ownerPolicy])).mutation(async ({ ctx }) =>
            ctx.db.insertMany("documents", [
                { ownerId: "u1", title: "a" },
                { ownerId: "someone-else", title: "b" },
            ]),
        );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });
        // The denial is raised during per-row policy evaluation, so the writer's
        // batch is never invoked — no partial write.
        expect(database.calls.some((call) => call.method === "insertMany")).toBe(false);
    });

    it("insertManyUnsafe still enforces the insert policy (RLS is not bypassed)", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([ownerPolicy])).mutation(async ({ ctx }) =>
            ctx.db.insertManyUnsafe("documents", [
                { ownerId: "u1", title: "a" },
                { ownerId: "u1", title: "b" },
            ]),
        );

        const ids = await handler.handler(makeContext(database, "u1"), {});

        expect(ids).toHaveLength(2);
        // "Unsafe" skips validators/triggers, NOT RLS — the authorized batch still
        // routes through the delegated unsafe writer.
        expect(database.calls.some((call) => call.method === "insertManyUnsafe")).toBe(true);
    });

    it("insertManyUnsafe denies the batch (FORBIDDEN) when a row fails its policy, before any write", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([ownerPolicy])).mutation(async ({ ctx }) =>
            ctx.db.insertManyUnsafe("documents", [
                { ownerId: "u1", title: "a" },
                { ownerId: "someone-else", title: "b" },
            ]),
        );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "FORBIDDEN",
            name: "LunoraError",
        });
        expect(database.calls.some((call) => call.method === "insertManyUnsafe")).toBe(false);
    });

    const deletePolicy = definePolicy<TestContext>({
        on: "delete",
        table: "documents",
        when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
    });

    const updatePolicy = definePolicy<TestContext>({
        on: "update",
        table: "documents",
        when: ({ auth, row }) => row?.["ownerId"] === auth.userId,
    });

    it("deleteMany gates each id (per-id locate + policy) and deletes the authorized rows", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u1", table: "documents" },
        ]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteMany(["d1", "d2"]));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 2 });
        // The middleware loops per-id through the single-delete gate (mixed
        // routing precludes one batch call), so each row is gated + deleted.
        expect(database.calls.filter((call) => call.method === "delete")).toHaveLength(2);
    });

    it("deleteMany denies the batch (FORBIDDEN) when a row fails its policy, before deleting it", async () => {
        expect.assertions(2);

        // The forbidden row is FIRST, so the per-id gate throws before any delete.
        const database = createFakeDatabase([
            { _id: "d1", ownerId: "someone-else", table: "documents" },
            { _id: "d2", ownerId: "u1", table: "documents" },
        ]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteMany(["d1", "d2"]));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "delete")).toBe(false);
    });

    it("patchMany gates each id and patches the authorized rows", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u1", table: "documents" },
        ]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([updatePolicy])).mutation(async ({ ctx }) =>
            ctx.db.patchMany([
                { id: "d1", patch: { title: "a" } },
                { id: "d2", patch: { title: "b" } },
            ]),
        );

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.filter((call) => call.method === "patch")).toHaveLength(2);
        expect(database.calls.some((call) => call.method === "patchMany")).toBe(false);
    });

    it("patchMany denies the batch (FORBIDDEN) when a row fails its policy, before patching it", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "someone-else", table: "documents" }]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([updatePolicy]))
            .mutation(async ({ ctx }) => ctx.db.patchMany([{ id: "d1", patch: { title: "x" } }]));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "patch")).toBe(false);
    });

    it("deleteAll gates each row rather than delegating to the writer's uncapped erase", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([
            { _id: "d1", ownerId: "u1", table: "documents" },
            { _id: "d2", ownerId: "u1", table: "documents" },
        ]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 2 });
        // Each row went through the single-delete gate...
        expect(database.calls.filter((call) => call.method === "delete")).toHaveLength(2);
        // ...and the underlying writer's own `deleteAll` was never called: it loops
        // its RAW delete, which would bypass every policy.
        expect(database.calls.some((call) => call.method === "deleteAll")).toBe(false);
    });

    it("deleteAll chunks without re-locating any row it already read", async () => {
        expect.assertions(5);

        const database = createFakeDatabase(
            Array.from({ length: 300 }, (_, index) => {
                return { _id: `d${String(index)}`, ownerId: "u1", table: "documents" };
            }),
        );

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([deletePolicy]))
            .mutation(async ({ ctx }) => ctx.db.deleteAll("documents", { chunkSize: 100, hard: true }));

        // The fake ignores `limit` and never drops deleted rows; serve real chunks so the loop drains.
        const alive = new Set(Array.from({ length: 300 }, (_, index) => `d${String(index)}`));
        const { delete: recordDelete, findMany } = database.writer;

        const pinnedTables: (string | undefined)[] = [];

        database.writer.delete = async (id, expectedTable, options) => {
            alive.delete(id);
            pinnedTables.push(expectedTable);

            return recordDelete(id, expectedTable, options);
        };
        database.writer.findMany = async (tableName, args) => {
            const all = await findMany(tableName, args);
            const page = all.page.filter((row) => alive.has(String(row["_id"]))).slice(0, (args as { limit?: number } | undefined)?.limit ?? 100);

            return { ...all, page };
        };

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 300 });

        const deletes = database.calls.filter((call) => call.method === "delete");

        expect(deletes).toHaveLength(300);
        expect(deletes[0]?.args).toStrictEqual({ hard: true });
        // Every delete is pinned to the erased table, so the engine probes only that table.
        expect(pinnedTables.every((table) => table === "documents")).toBe(true);
        // No per-row `get` / `findFirst` probe: the verdict ran on the page the scoped read returned.
        expect(database.calls.filter((call) => call.method === "get" || call.method === "findFirst")).toHaveLength(0);
    });

    /**
     * Seed a parent P and its child C, and make deleting P null C's `parentId` the way a cascade or a delete trigger
     * that patches the next row does. `rereadTables` is what the writer publishes as `deleteRereadTables`.
     */
    const seedSelfReferential = (rereadTables: ReadonlyArray<string>) => {
        const rows = [
            { _id: "P", parentId: "root", table: "documents" },
            { _id: "C", parentId: "P", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;
        const alive = new Set(["C", "P"]);

        Object.assign(database.writer, { deleteRereadTables: new Set(rereadTables) });
        database.writer.delete = async (id) => {
            database.calls.push({ args: undefined, method: "delete", tableOrId: id });
            alive.delete(id);

            for (const row of rows) {
                if (row.parentId === id) {
                    row.parentId = null as unknown as string;
                }
            }
        };
        // Page images are snapshots: a later delete in the page must not reach back into them.
        database.writer.findMany = async (tableName, args) => {
            const all = await findMany(tableName, args);

            return {
                ...all,
                page: all.page
                    .filter((row) => alive.has(String(row["_id"])))
                    .map((row) => {
                        return { ...row };
                    }),
            };
        };

        return database;
    };

    const parentIdPolicy = definePolicy<TestContext>({ on: "delete", table: "documents", when: ({ row }) => row?.["parentId"] != null });

    it("deleteAll re-reads a later row of a listed table, so a cascade or trigger patch cannot leave it deletable", async () => {
        expect.assertions(2);

        const database = seedSelfReferential(["documents"]);
        const handler = lunora.mutation.use(rlsForTest<TestContext>([parentIdPolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // P is deleted first and nulls C's `parentId`; C's current image is denied.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["P"]);
    });

    it("deleteAll re-reads every row of a .global() table, so another shard's update after the page read is seen", async () => {
        expect.assertions(2);

        const rows = [
            { _id: "A", parentId: "x", table: "documents" },
            { _id: "B", parentId: "x", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        Object.assign(database.writer, { deleteRereadTables: new Set(["documents"]) });
        // The page is a snapshot; then another shard turns B into a policy-denied row before the delete reaches it.
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            rows[1]!.parentId = null as unknown as string;

            return { ...result, page };
        };

        const handler = lunora.mutation.use(rlsForTest<TestContext>([parentIdPolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A"]);
    });

    it("deleteAll skips a .global() row another shard deleted after the page read", async () => {
        expect.assertions(3);

        const rows = [
            { _id: "A", parentId: "x", table: "documents" },
            { _id: "B", parentId: "x", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        Object.assign(database.writer, { deleteRereadTables: new Set(["documents"]) });
        database.writer.get = async (id) => rows.find((row) => row._id === id) ?? null;
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            // Another shard deletes B between the page read and the delete.
            rows.splice(1, 1);

            return { ...result, page };
        };

        const handler = lunora.mutation.use(rlsForTest<TestContext>([parentIdPolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // Only A is deleted by this call; the vanished B is skipped, not deleted and not counted.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A"]);
        expect(rows).toHaveLength(1);
    });

    it("deleteAll keeps the no-relocate fast path when the table is not listed", async () => {
        expect.assertions(3);

        // Another listed table must not cost `documents` the fast path.
        const database = seedSelfReferential(["comments"]);

        enableGetWithTable(database, []);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([parentIdPolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // Without a re-read, C's stale image (parentId "P") passes the policy.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 2 });
        expect(database.calls.filter((call) => call.method === "delete")).toHaveLength(2);
        expect(database.calls.filter((call) => ["findFirst", "get", "lookupById"].includes(call.method))).toHaveLength(0);
    });

    it("deleteAll denies (FORBIDDEN) when a row fails its policy, before deleting it", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "someone-else", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "delete")).toBe(false);
    });

    it("deleteAll pins the erased table; the engine still reaches a .global() row through that pin", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        // The ids came from this table's own policy-filtered read, so the delete is pinned to it; the
        // engine's global fallback honours a pin on a `.global()` table itself.
        const deletes = database.calls.filter((call) => call.method === "delete");

        expect(deletes).toHaveLength(1);
        expect(deletes[0]?.args).toBeUndefined();
    });

    it("deleteAll from an action re-locates every row: outside the mutation's transaction the page image can change", async () => {
        expect.assertions(2);

        const rows = [
            { _id: "A", ownerId: "u1", parentId: "x", table: "documents" },
            { _id: "B", ownerId: "u1", parentId: "x", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        // An action: no open transaction, so the page is only a snapshot.
        Object.assign(database.writer, { inTransaction: () => false });
        // A concurrent write reassigns B after the page read; only the fresh image may be trusted.
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            rows[1]!.parentId = null as unknown as string;

            return { ...result, page };
        };

        const handler = lunora.action.use(rlsForTest<TestContext>([parentIdPolicy])).action(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // The fresh image denies B, so the erase stops rather than deleting a row it may no longer own.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A"]);
    });

    it("deleteAll counts a row an earlier self-cascade soft-deleted only once", async () => {
        expect.assertions(2);

        const rows: (Record<string, unknown> & { _id: string; table: string })[] = [
            { _id: "P", deletedAt: null, parentId: "root", table: "documents" },
            { _id: "C", deletedAt: null, parentId: "P", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        Object.assign(database.writer, {
            // Self-cascading AND soft-deleting: re-read each row, and treat a stamped row as gone.
            deleteRereadTables: new Set(["documents"]),
            softDeleteFields: new Map([["documents", "deletedAt"]]),
        });
        database.writer.delete = async (id) => {
            database.calls.push({ args: undefined, method: "delete", tableOrId: id });

            for (const row of rows) {
                if (row._id === id || row.parentId === id) {
                    row.deletedAt = 1;
                }
            }
        };
        // Page images are snapshots: the preserved rows are filtered like the writer's own live read.
        database.writer.findMany = async (tableName, args) => {
            const all = await findMany(tableName, args);

            return {
                ...all,
                page: all.page
                    .filter((row) => row.deletedAt === null)
                    .map((row) => {
                        return { ...row };
                    }),
            };
        };

        const handler = lunora.mutation.use(rlsForTest<TestContext>([parentIdPolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // P is deleted; C was cascade-soft-deleted, so its tombstone is skipped rather than re-counted.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["P"]);
    });

    it("deleteAll counts a row a cascade removed only once on a policy-less table too", async () => {
        expect.assertions(2);

        const rows = [
            { _id: "P", parentId: "root", table: "plain" },
            { _id: "C", parentId: "P", table: "plain" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;
        const alive = new Set(["C", "P"]);

        Object.assign(database.writer, { deleteRereadTables: new Set(["plain"]) });
        database.writer.delete = async (id) => {
            database.calls.push({ args: undefined, method: "delete", tableOrId: id });
            alive.delete(id);

            for (const row of rows) {
                if (row.parentId === id) {
                    alive.delete(row._id);
                }
            }
        };
        database.writer.findFirst = async (_tableName, args) => {
            const id = (args as { where?: { _id?: string } } | undefined)?.where?._id;

            return id !== undefined && alive.has(id) ? (rows.find((row) => row._id === id) ?? null) : null;
        };
        database.writer.findMany = async (tableName, args) => {
            const all = await findMany(tableName, args);

            return {
                ...all,
                page: all.page.map((row) => {
                    return { ...row };
                }),
            };
        };

        // A policy-less table (`plain`) still rides the reread set, so its vanished child is not counted.
        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("plain"));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["P"]);
    });

    it("deleteAll from an action skips a row a concurrent write moved out of the read scope", async () => {
        expect.assertions(2);

        const rows = [
            { _id: "A", ownerId: "u1", table: "documents" },
            { _id: "B", ownerId: "u1", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        // An action: no transaction. The fresh read re-applies the read scope (`baseWhere`).
        Object.assign(database.writer, { inTransaction: () => false });
        database.writer.findFirst = async (tableName, args) => {
            database.calls.push({ args, method: "findFirst", tableOrId: tableName });
            const options = args as { baseWhere?: { ownerId?: { eq?: string } }; includeDeleted?: boolean; where?: { _id?: string } } | undefined;
            const id = options?.where?._id;
            const owner = options?.baseWhere?.ownerId?.eq;

            return rows.find((row) => row.table === tableName && row._id === id && (owner === undefined || row.ownerId === owner)) ?? null;
        };
        // A concurrent mutation transfers B to another owner after the page read.
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            rows[1]!.ownerId = "someone-else";

            return { ...result, page };
        };

        const readOwn = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: { eq: auth.userId } };
            },
        });
        const deleteAny = definePolicy<TestContext>({ on: "delete", table: "documents", when: () => true });
        const handler = lunora.action.use(rlsForTest<TestContext>([readOwn, deleteAny])).action(async ({ ctx }) => ctx.db.deleteAll("documents"));

        // B left the caller's read scope, so it is not erased even though the delete policy allows it.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A"]);
    });

    it("deleteWhere from an action skips a row a concurrent write moved out of its filter", async () => {
        expect.assertions(2);

        const rows = [
            { _id: "A", status: "archived", table: "documents" },
            { _id: "B", status: "archived", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        // An action: no transaction, so `deleteWhere` re-locates each row.
        Object.assign(database.writer, { inTransaction: () => false });
        // The re-location applies the caller's filter through the SQL path (merged as `{ AND: [{ _id }, { status }] }`).
        database.writer.findFirst = async (tableName, args) => {
            database.calls.push({ args, method: "findFirst", tableOrId: tableName });
            const where = (args as { where?: { _id?: string; AND?: [{ _id?: string }, { status?: string }] } } | undefined)?.where;
            const id = where?._id ?? where?.AND?.[0]?._id;
            const status = where?.AND?.[1]?.status;
            const row = rows.find((entry) => entry.table === tableName && entry._id === id);

            return row && (status === undefined || row.status === status) ? row : null;
        };
        // A concurrent write un-archives B after the page read.
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            rows[1]!.status = "active";

            return { ...result, page };
        };

        // The row is also delete-denied once un-archived; it must still be skipped, not abort the erase.
        const deleteArchived = definePolicy<TestContext>({ on: "delete", table: "documents", when: ({ row }) => row?.["status"] === "archived" });
        const handler = lunora.action
            .use(rlsForTest<TestContext>([deleteArchived]))
            .action(async ({ ctx }) => ctx.db.deleteWhere("documents", { status: "archived" }));

        // B left the filter (and is now delete-denied), so it is skipped, not erased and not an abort.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A"]);
    });

    it("deleteAll with { hard: true } reaches a row that became soft-deleted after the page read", async () => {
        expect.assertions(2);

        const rows: (Record<string, unknown> & { _id: string; table: string })[] = [
            { _id: "A", deletedAt: null, ownerId: "u1", table: "documents" },
            { _id: "B", deletedAt: null, ownerId: "u1", table: "documents" },
        ];
        const database = createFakeDatabase(rows);
        const { findMany } = database.writer;

        Object.assign(database.writer, { inTransaction: () => false, softDeleteFields: new Map([["documents", "deletedAt"]]) });
        database.writer.findFirst = async (tableName, args) => {
            database.calls.push({ args, method: "findFirst", tableOrId: tableName });
            const options = args as { includeDeleted?: boolean; where?: { _id?: string } } | undefined;
            const row = rows.find((entry) => entry.table === tableName && entry._id === options?.where?._id);

            if (!row) {
                return null;
            }

            // A live-only read hides the tombstone; `includeDeleted` resurfaces it for a hard erase.
            return row.deletedAt === null || options?.includeDeleted === true ? row : null;
        };
        // A concurrent mutation soft-deletes B after the page read.
        database.writer.findMany = async (tableName, args) => {
            const result = await findMany(tableName, args);
            const page = result.page.map((row) => {
                return { ...row };
            });

            rows[1]!.deletedAt = 1;

            return { ...result, page };
        };

        const deleteAny = definePolicy<TestContext>({ on: "delete", table: "documents", when: () => true });
        const handler = lunora.mutation.use(rlsForTest<TestContext>([deleteAny])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents", { hard: true }));

        // The hard erase must physically remove the row, tombstone or not: it is found and deleted.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 2 });
        expect(database.calls.filter((call) => call.method === "delete").map((call) => call.tableOrId)).toStrictEqual(["A", "B"]);
    });

    it("deleteAll re-locates with the same relation read filter its page read used", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "A", ownerId: "u1", table: "documents" }]);

        // Force the re-location path (a listed table) and capture the read filter each read threads.
        Object.assign(database.writer, { deleteRereadTables: new Set(["documents"]) });

        const filters: unknown[] = [];
        const { findMany } = database.writer;

        database.writer.findMany = async (tableName, args) => {
            filters.push((args as { relationBaseWhere?: unknown } | undefined)?.relationBaseWhere);

            return findMany(tableName, args);
        };
        database.writer.findFirst = async (_tableName, args) => {
            filters.push((args as { relationBaseWhere?: unknown } | undefined)?.relationBaseWhere);

            return { _id: "A", ownerId: "u1", table: "documents" };
        };

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.deleteAll("documents"));

        await handler.handler(makeContext(database, "u1"), {});

        // Page read and re-location carry the SAME child read filter, so a relation-based read policy
        // cannot re-admit a parent through a child the caller can no longer read.
        expect(filters[0]).toBeTypeOf("function");
        expect(filters[0]).toBe(filters[1]);
    });

    it("deleteWhere re-locates a policy-less row with the relation read filter applied", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "P", table: "plain" }]);

        Object.assign(database.writer, { deleteRereadTables: new Set(["plain"]) });

        let rereadArgs: unknown;
        database.writer.findFirst = async (_tableName, args) => {
            rereadArgs = args;

            return { _id: "P", table: "plain" };
        };

        // `plain` carries no policy; the erase is scoped only by the caller's relational `where`, whose child
        // hop must still be filtered by `relationReadFilter` on the re-location read.
        const handler = lunora.action
            .use(rlsForTest<TestContext>([]))
            .action(async ({ ctx }) => ctx.db.deleteWhere("plain", { parent: { is: { id: "child" } } }));

        await handler.handler(makeContext(database, "u1"), {});

        expect((rereadArgs as { relationBaseWhere?: unknown }).relationBaseWhere).toBeTypeOf("function");
        expect(database.calls.filter((call) => call.method === "delete")).toHaveLength(1);
    });

    it("deleteWhere accepts an Infinity limit and reads every match instead of a capped page", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "P", table: "plain" }]);

        const handler = lunora.action
            .use(rlsForTest<TestContext>([]))
            .action(async ({ ctx }) => ctx.db.deleteWhere("plain", {}, { limit: Number.POSITIVE_INFINITY }));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ deleted: 1 });
        expect(database.calls.find((call) => call.method === "findMany")?.args).not.toHaveProperty("limit");
    });

    it("refuses an over-cap deleteMany with the writer's BATCH_LIMIT_EXCEEDED code and message", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);
        const ids = Array.from({ length: 501 }, (_, index) => `d${String(index)}`);

        const handler = lunora.action.use(rlsForTest<TestContext>([])).action(async ({ ctx }) => ctx.db.deleteMany(ids));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "BATCH_LIMIT_EXCEEDED",
            message: "deleteMany: batch of 501 exceeds the limit of 500 (raise options.limit or chunk the call)",
            status: 400,
        });
    });

    it("refuses a negative deleteWhere limit before reading", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "P", table: "plain" }]);

        const handler = lunora.action.use(rlsForTest<TestContext>([])).action(async ({ ctx }) => ctx.db.deleteWhere("plain", {}, { limit: -1 }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "BATCH_LIMIT_EXCEEDED",
            message: "deleteWhere: batch limit must be a non-negative integer",
        });
        expect(database.calls.some((call) => call.method === "findMany")).toBe(false);
    });

    it("wipeShard fails closed under rls() instead of erasing only policy-visible rows", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);

        const handler = lunora.mutation.use(rlsForTest<TestContext>([deletePolicy])).mutation(async ({ ctx }) => ctx.db.wipeShard());

        // "Erase everything I can see" is not an erasure guarantee — a read policy
        // hiding rows would silently leave them behind. Account deletion belongs in
        // an internalMutation.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "FORBIDDEN", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "delete")).toBe(false);
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

    it("rejects a relation-crossing predicate in a write policy with RELATION_PREDICATE_UNSUPPORTED", async () => {
        expect.assertions(2);

        // The in-memory write evaluator has no child fetcher, so a relation
        // predicate (`is`/`some`/…) can't be resolved against a single candidate
        // row. It must fail loudly rather than silently deny — relation
        // predicates belong in read policies / query `where`, not write policies.
        const policy = definePolicy<TestContext>({
            on: "insert",
            table: "documents",
            when: ({ auth }) => {
                return { author: { is: { _id: { eq: auth.userId } } } };
            },
        });
        const database = createFakeDatabase([]);

        const handler = lunora.mutation
            .use(rlsForTest<TestContext>([policy]))
            .mutation(async ({ ctx }) => ctx.db.insert("documents", { ownerId: "u1", title: "x" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({
            code: "RELATION_PREDICATE_UNSUPPORTED",
            name: "LunoraError",
        });
        expect(database.calls.some((call) => call.method === "insert")).toBe(false);
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

    /**
     * A read policy that grants unconditionally for this request produces no
     * `baseWhere`: the caller sees the whole partition, so a count or a rank
     * over it is exact. Failing those closed on the mere PRESENCE of a policy
     * made `count()`/`rank()`/`rankPage()` unreachable from the very procedures
     * the policy admits — including every admin/`can(...)` branch.
     */
    const allowAllPolicy = definePolicy<TestContext>({ on: "read", table: "documents", when: () => true });

    it("serves count() under an allow-all read policy without flagging restrictsCounts", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([allowAllPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.count("documents"));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toBe(1);

        const call = database.calls.find((entry) => entry.method === "count");

        expect((call?.args as { restrictsCounts?: boolean }).restrictsCounts).toBe(false);
    });

    it("serves rank() under an allow-all read policy", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([allowAllPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("documents", "byScore", { row: "d1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toMatchObject({ position: 1 });

        expect(database.calls.some((entry) => entry.method === "rank")).toBe(true);
    });

    it("serves rankPage() under an allow-all read policy", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([allowAllPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("documents", "byScore"));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toMatchObject({ isDone: true });
    });

    it("forwards the caller's own rank() baseWhere untouched — the guard contributes none", async () => {
        expect.assertions(1);

        // `assertUnrestrictedReadBase` is a check, not a producer: reaching past it
        // means the read base is unrestricted, so there is nothing to AND in and the
        // caller's `options` go through as written.
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([allowAllPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("documents", "byScore", { baseWhere: { ownerId: "u1" }, row: "d1" }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.find((entry) => entry.method === "rank")?.args).toStrictEqual({ baseWhere: { ownerId: "u1" }, row: "d1" });
    });

    it("serves rank() under a read policy whose predicate is an empty (match-everything) WhereInput", async () => {
        expect.assertions(1);

        // `{}` matches every row and `mergeBaseWhere` already drops it, so the
        // fail-closed guard has to read it the same way or it blocks a rank it
        // does not restrict.
        const emptyPredicate = definePolicy<TestContext>({
            on: "read",
            table: "documents",
            when: () => {
                return {};
            },
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.query
            .use(rlsForTest<TestContext>([emptyPredicate]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("documents", "byScore", { row: "d1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toMatchObject({ position: 1 });
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

    it("fails rankPageRows() closed with COUNT_RLS_UNSUPPORTED under a read policy (plan 254)", async () => {
        expect.assertions(2);

        const rows = [{ _id: "d1", ownerId: "u1", table: "documents" }];
        const database = createFakeDatabase(rows);

        enableRankPageRows(database, rows);

        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPageRows?.("documents", "byScore"));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "COUNT_RLS_UNSUPPORTED" });
        // The underlying writer is never reached — the guard throws first.
        expect(database.calls.some((entry) => entry.method === "rankPageRows")).toBe(false);
    });

    it("leaves rankPageRows() UNRESTRICTED on a table with no read policy (plan 254)", async () => {
        expect.assertions(2);

        const rows = [{ _id: "e1", table: "events" }];
        const database = createFakeDatabase(rows);

        enableRankPageRows(database, rows);

        const handler = lunora.query
            .use(rlsForTest<TestContext>([ownerPolicy]))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPageRows?.("events", "byTime"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.rows).toHaveLength(1);
        expect(database.calls.some((entry) => entry.method === "rankPageRows")).toBe(true);
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
                get: (id: string) => writer.get(tableName, id),
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
            auth: { userId },
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

    /**
     * This test previously asserted the OPPOSITE — that a non-policy table's
     * facade entry keeps its original binding — on the stated grounds that a
     * `.global()` table's entry is bound to the D1 `globalDb` writer and
     * re-binding it would query the wrong backend.
     *
     * That premise is false. `packages/codegen/src/emit/shard.ts` binds EVERY table's
     * facade entry through the one shard ctx-db, `.global()` included, and says
     * why in its own comment: `createShardCtxDb` routes global ops to D1
     * internally and stamps the subscription hooks, so binding a global facade
     * straight to `globalDb` would skip both. There is no wrong backend to route
     * to, and the exemption bought nothing while costing a read filter.
     */
    it("re-binds EVERY facade entry once any policy is in scope, policy table or not", async () => {
        expect.assertions(2);

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

        expect(documentsEntry).not.toBe(originalDocuments);
        expect(eventsEntry).not.toBe(originalEvents);
    });

    it("threads relationBaseWhere through a NON-policy table's facade, so a hop cannot hydrate hidden rows", async () => {
        expect.assertions(1);

        // The bypass: `events` has no policy, so its facade entry was never
        // re-bound and reached the raw writer with no `relationBaseWhere`. A
        // `with` hop onto `documents` — which DOES have a read policy — then
        // hydrated and returned rows the policy exists to hide. The flat method
        // form `ctx.db.findMany("events", …)` was guarded the whole time; only
        // the idiomatic facade form leaked.
        const database = createFakeDatabase([]);

        const handler = lunora.query.use(rlsForTest<TestContext>([ownerPolicy])).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, { findMany: (args?: unknown) => Promise<unknown> }> };

            return db["events"]!.findMany({ with: { documents: true } });
        });

        await handler.handler(makeFacadeContext(database, "u1"), {});

        expect((database.calls.at(-1)?.args as { relationBaseWhere?: unknown }).relationBaseWhere).toBeTypeOf("function");
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

describe("rls — soft-delete write methods (restore / hardDelete)", () => {
    it("restore is gated as an update — denied for a non-owner", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);
        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.restore("d1"));

        // u1 is not the owner → the update policy denies the restore.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toThrow(/denied/u);
        // And the underlying writer was never reached.
        expect(database.calls.some((call) => call.method === "restore")).toBe(false);
    });

    it("restore reaches the writer for the owner", async () => {
        expect.assertions(1);

        const policy = definePolicy<TestContext>({
            on: "update",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.restore("d1"));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "restore")).toBe(true);
    });

    it("hardDelete forwards `{ hard: true }` through the delete gate", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "delete",
            table: "documents",
            when: () => true,
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u1", table: "documents" }]);
        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1", undefined, { hard: true }));

        await handler.handler(makeContext(database, "u1"), {});

        const deleteCall = database.calls.find((call) => call.method === "delete");

        expect(deleteCall?.tableOrId).toBe("d1");
        // The `{ hard: true }` option survives the RLS wrapper → the writer soft/hard branch sees it.
        expect(deleteCall?.args).toStrictEqual({ hard: true });
    });

    it("hardDelete is still denied by the delete policy", async () => {
        expect.assertions(2);

        const policy = definePolicy<TestContext>({
            on: "delete",
            table: "documents",
            when: ({ auth }) => {
                return { ownerId: auth.userId };
            },
        });
        const database = createFakeDatabase([{ _id: "d1", ownerId: "u2", table: "documents" }]);
        const handler = lunora.mutation.use(rlsForTest<TestContext>([policy])).mutation(async ({ ctx }) => ctx.db.delete("d1", undefined, { hard: true }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toThrow(/denied/u);
        expect(database.calls.some((call) => call.method === "delete")).toBe(false);
    });
});
