/**
 * Secure-by-default routing (RLS-maturity gap #1).
 *
 * Under a `defineSchema(...).rls("required")` schema the generated `ctx.db` is a
 * GUARDED writer (`@lunora/do`'s `guardWriter`): every non-`.public()` table is
 * denied unless RLS was engaged. The `rls()` middleware must (a) recover the
 * unwrapped writer (via the shared `Symbol.for` key) and route a POLICY table's
 * reads/writes through it, so policies still work; and (b) leave a NON-policy
 * table routed through the GUARD, so a protected table with no policy stays
 * denied even inside an RLS procedure (you must declare a policy to reach it)
 * while a `.public()` table passes through.
 *
 * We don't import `@lunora/do` here (wrong dependency direction); instead we build
 * a minimal guarded writer inline that mirrors the guard contract — gated methods
 * throw for protected tables, and the raw writer hangs off the same well-known
 * symbol the middleware reads.
 */
import { describe, expect, it } from "vitest";

import type { Middleware, Policy } from "../src/index";
import { definePolicies, definePolicy, initLunora, LunoraError, rls } from "../src/index";

const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

/** The cross-realm key `@lunora/do`'s `guardWriter` hangs the unwrapped writer off of. */
const RLS_UNWRAP_SYMBOL = Symbol.for("lunora.ctxdb.rls-unwrap");

/** Error shape the inline guard throws (mirrors `RlsRequiredError` structurally). */
class FakeRlsRequiredError extends Error {
    public readonly code = "RLS_REQUIRED";

    public constructor(table: string) {
        super(`ctx.db access to "${table}" is denied (.rls("required"))`);
        this.name = "RlsRequiredError";
    }
}

interface Row {
    _id: string;
    table: string;
}

/** A raw writer over seeded rows; records which writer serviced each read. */
const createRawWriter = (rows: Row[], log: string[]) => {
    const rowsOfTable = (tableName: string): Row[] => rows.filter((row) => row.table === tableName);

    return {
        async aggregate(tableName: string) {
            log.push(`raw.aggregate:${tableName}`);

            return rowsOfTable(tableName).length;
        },
        async count(tableName: string) {
            log.push(`raw.count:${tableName}`);

            return rowsOfTable(tableName).length;
        },
        async delete(id: string) {
            log.push(`raw.delete:${id}`);
        },
        async findFirst(tableName: string, args?: { where?: { _id?: string } }) {
            log.push(`raw.findFirst:${tableName}`);
            const list = rowsOfTable(tableName);
            const wantedId = args?.where?._id;

            if (typeof wantedId === "string") {
                return list.find((row) => row._id === wantedId) ?? null;
            }

            return list[0] ?? null;
        },
        async findFirstOrThrow(tableName: string) {
            log.push(`raw.findFirstOrThrow:${tableName}`);

            return rowsOfTable(tableName)[0] ?? null;
        },
        async findMany(tableName: string) {
            log.push(`raw.findMany:${tableName}`);

            return { continueCursor: null, isDone: true, page: rowsOfTable(tableName) };
        },
        async get(id: string) {
            log.push(`raw.get:${id}`);

            return rows.find((row) => row._id === id) ?? null;
        },
        async lookupById(id: string) {
            log.push(`raw.lookupById:${id}`);
            const row = rows.find((entry) => entry._id === id);

            return row ? { row, tableName: row.table } : null;
        },
        async groupBy(tableName: string) {
            log.push(`raw.groupBy:${tableName}`);

            return [{ key: {}, value: rowsOfTable(tableName).length }];
        },
        async insert(tableName: string, document: Record<string, unknown>) {
            log.push(`raw.insert:${tableName}`);

            return (document._id as string | undefined) ?? "new-id";
        },
        async patch(id: string) {
            log.push(`raw.patch:${id}`);
        },
        query(tableName: string): never {
            log.push(`raw.query:${tableName}`);
            throw new Error("query() not exercised");
        },
        async rank(tableName: string) {
            log.push(`raw.rank:${tableName}`);

            return { position: 1, total: rowsOfTable(tableName).length };
        },
        async rankPage(tableName: string) {
            log.push(`raw.rankPage:${tableName}`);

            return { continueCursor: null, isDone: true, page: rowsOfTable(tableName) };
        },
        async replace(id: string) {
            log.push(`raw.replace:${id}`);
        },
    };
};

type RawWriter = ReturnType<typeof createRawWriter>;

/**
 * Wrap a raw writer in a guard mirroring `@lunora/do`'s `guardWriter`: table-named
 * + id-based gated methods throw for a non-public table; the unwrapped writer
 * hangs off `RLS_UNWRAP_SYMBOL`. `protectedTables` is the set the guard denies.
 */
const guard = (raw: RawWriter, protectedTables: Set<string>, tableOfId: (id: string) => string | undefined): RawWriter => {
    const deny = (tableName: string): void => {
        if (protectedTables.has(tableName)) {
            throw new FakeRlsRequiredError(tableName);
        }
    };

    const denyById = (id: string): void => {
        const tableName = tableOfId(id);

        if (tableName !== undefined) {
            deny(tableName);
        }
    };

    const guarded = {
        ...raw,
        aggregate: (tableName: string) => {
            deny(tableName);

            return raw.aggregate(tableName);
        },
        count: (tableName: string) => {
            deny(tableName);

            return raw.count(tableName);
        },
        delete: async (id: string) => {
            denyById(id);

            return raw.delete(id);
        },
        findFirst: (tableName: string, args?: { where?: { _id?: string } }) => {
            deny(tableName);

            return raw.findFirst(tableName, args);
        },
        findFirstOrThrow: (tableName: string) => {
            deny(tableName);

            return raw.findFirstOrThrow(tableName);
        },
        findMany: (tableName: string) => {
            deny(tableName);

            return raw.findMany(tableName);
        },
        get: async (id: string) => {
            denyById(id);

            return raw.get(id);
        },
        groupBy: (tableName: string) => {
            deny(tableName);

            return raw.groupBy(tableName);
        },
        insert: (tableName: string, document: Record<string, unknown>) => {
            deny(tableName);

            return raw.insert(tableName, document);
        },
        patch: async (id: string) => {
            denyById(id);

            return raw.patch(id);
        },
        replace: async (id: string) => {
            denyById(id);

            return raw.replace(id);
        },
    };

    // NON-enumerable, mirroring the real `guardWriter`. An enumerable escape
    // hatch rides the `{ ...ctx.db }` spread the RLS wrapper is built from, which
    // re-published the unguarded writer off the wrapper.
    Object.defineProperty(guarded, RLS_UNWRAP_SYMBOL, { configurable: true, enumerable: false, value: raw });

    return guarded;
};

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface TestContext {
    auth: { roles?: ReadonlyArray<string>; userId: null | string };
    db: RawWriter;
}

describe("rls — secure-by-default routing over a guarded writer", () => {
    const protectedTables = new Set(["posts", "secrets"]);
    const tableOfId = (id: string): string | undefined => {
        if (id.startsWith("post_")) {
            return "posts";
        }

        if (id.startsWith("secret_")) {
            return "secrets";
        }

        return undefined;
    };

    const readPosts = definePolicy<TestContext>({
        on: "read",
        table: "posts",
        when: ({ auth }) => {
            return { ownerId: auth.userId };
        },
    });

    // `secrets` participates in the bundle ONLY via a write (insert) policy — it
    // has no read policy. Reads of it must still fail closed through the guard.
    const insertSecrets = definePolicy<TestContext>({
        on: "insert",
        table: "secrets",
        when: () => true,
    });

    it("routes a POLICY table read through the unwrapped writer (policies still work)", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const raw = createRawWriter([{ _id: "post_1", table: "posts" }], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        const handler = lunora.query.use(rlsForTest<TestContext>(definePolicies([readPosts]))).query(async ({ ctx }) => ctx.db.findMany("posts"));

        const result = await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        // Reached raw (not denied) and carries the policy's baseWhere.
        expect(log).toContain("raw.findMany:posts");
        expect(result).toMatchObject({ isDone: true });
    });

    it("dENIES a protected NON-policy table read inside an RLS procedure (must declare a policy)", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const raw = createRawWriter([{ _id: "secret_1", table: "secrets" }], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        // The procedure has a policy for `posts` but touches `secrets`.
        const handler = lunora.query.use(rlsForTest<TestContext>(definePolicies([readPosts]))).query(async ({ ctx }) => ctx.db.findMany("secrets"));

        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).rejects.toThrow(FakeRlsRequiredError);
        // The guard fired before ever reaching the raw writer.
        expect(log).not.toContain("raw.findMany:secrets");
    });

    it("allows a .public() NON-policy table read through the guard (opt-out)", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const raw = createRawWriter([{ _id: "s1", table: "stats" }], log);
        const guarded = guard(raw, protectedTables, tableOfId); // `stats` not protected
        const handler = lunora.query.use(rlsForTest<TestContext>(definePolicies([readPosts]))).query(async ({ ctx }) => ctx.db.findMany("stats"));

        await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        expect(log).toContain("raw.findMany:stats");
    });

    it("dENIES an insert into a protected NON-policy table inside an RLS procedure", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const raw = createRawWriter([], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(definePolicies([readPosts])))
            .mutation(async ({ ctx }) => ctx.db.insert("secrets", { x: 1 }));

        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).rejects.toThrow(FakeRlsRequiredError);
        expect(log).not.toContain("raw.insert:secrets");
    });

    it("is a no-op for a non-guarded writer (base === raw, unchanged behavior)", async () => {
        expect.assertions(1);

        const log: string[] = [];
        // No guard wrapper, no symbol → middleware falls back to ctx.db for both base and raw.
        const raw = createRawWriter([{ _id: "post_1", table: "posts" }], log);
        const handler = lunora.query.use(rlsForTest<TestContext>(definePolicies([readPosts]))).query(async ({ ctx }) => ctx.db.findMany("posts"));

        await handler.handler({ auth: { userId: "u1" }, db: raw }, {});

        expect(log).toContain("raw.findMany:posts");
    });

    it("dENIES reading a protected WRITE-ONLY-policy table (no read policy) — no leak via raw (regression)", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const raw = createRawWriter([{ _id: "secret_1", table: "secrets" }], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        // `secrets` is in the bundle via an INSERT policy but has NO read policy.
        // A read must fail closed through the guard, NOT route to the unwrapped
        // writer and return every row (the write-only-policy read-open bug).
        const handler = lunora.query
            .use(rlsForTest<TestContext>(definePolicies([readPosts, insertSecrets])))
            .query(async ({ ctx }) => ctx.db.findMany("secrets"));

        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).rejects.toThrow(FakeRlsRequiredError);
        expect(log).not.toContain("raw.findMany:secrets");
    });

    it("dENIES get() on a protected WRITE-ONLY-policy table (no read policy) (regression)", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const raw = createRawWriter([{ _id: "secret_1", table: "secrets" }], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        const handler = lunora.query.use(rlsForTest<TestContext>(definePolicies([readPosts, insertSecrets]))).query(async ({ ctx }) => ctx.db.get("secret_1"));

        // The by-id path must defer to the guarded `base.get` (fail closed), never
        // return the row it located through the unwrapped writer.
        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).rejects.toThrow(FakeRlsRequiredError);
    });

    it("still allows writing the WRITE-ONLY-policy table (the insert policy works)", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const raw = createRawWriter([], log);
        const guarded = guard(raw, protectedTables, tableOfId);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(definePolicies([readPosts, insertSecrets])))
            .mutation(async ({ ctx }) => ctx.db.insert("secrets", { _id: "secret_9" }));

        await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        // The insert is authorized by its policy and routed to the unwrapped writer.
        expect(log).toContain("raw.insert:secrets");
    });

    it("keeps LunoraError importable for downstream policy-denial assertions", () => {
        expect.assertions(1);

        expect(LunoraError).toBeTypeOf("function");
    });
});

/**
 * Several `.use(rls(...))` steps in one chain must COMPOSE.
 *
 * The guarded writer publishes the unwrapped one under `RLS_UNWRAP_SYMBOL`, and
 * the RLS wrapper is built with `{ ...ctx.db }`. While that property was
 * enumerable the wrapper re-published it, so a SECOND `rls()` step recovered the
 * raw writer and wrapped THAT — routing around step one entirely, which turned
 * `rls([tenantScope])` followed by any other `rls(...)` into a full-table read.
 * Multiple steps are a shipped shape (`protectPublic({ use })`,
 * `composePluginMiddleware`, plain chained `.use()`), so the fix is composition,
 * not merely hiding the symbol.
 */
describe("rls — chained rls() steps compose", () => {
    const protectedTables = new Set(["posts", "secrets"]);
    const tableOfId = (id: string): string | undefined => (id.startsWith("post_") ? "posts" : undefined);

    const tenantPosts = definePolicy<TestContext>({
        on: "read",
        table: "posts",
        when: ({ auth }) => {
            return { ownerId: auth.userId };
        },
    });

    /** A second, broader bundle — the kind a feature flag or a plugin contributes. */
    const allPosts = definePolicy<TestContext>({ on: "read", table: "posts", when: () => true });

    const readSecrets = definePolicy<TestContext>({ on: "read", table: "secrets", when: () => true });

    /** Record what the underlying writer was actually asked for. */
    const recording = (raw: RawWriter): { args: unknown[]; writer: RawWriter } => {
        const args: unknown[] = [];

        return {
            args,
            writer: {
                ...raw,
                findMany: (tableName: string, callArgs?: unknown) => {
                    args.push(callArgs);

                    return raw.findMany(tableName);
                },
            },
        };
    };

    it("and-merges both steps' read filters (a later step cannot widen an earlier one)", async () => {
        expect.assertions(1);

        const { args, writer } = recording(createRawWriter([{ _id: "post_1", table: "posts" }], []));
        const guarded = guard(writer, protectedTables, tableOfId);
        const handler = lunora.query
            .use(rlsForTest<TestContext>(definePolicies([tenantPosts])))
            .use(rlsForTest<TestContext>(definePolicies([allPosts])))
            .query(async ({ ctx }) => ctx.db.findMany("posts"));

        await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        // Step two grants unrestricted access, so it adds no predicate — but step
        // one's tenant scope must survive it.
        expect(args[0]).toMatchObject({ baseWhere: { ownerId: "u1" } });
    });

    it("intersects a second step's narrower filter with the first rather than replacing it", async () => {
        expect.assertions(1);

        const draftsOnly = definePolicy<TestContext>({
            on: "read",
            table: "posts",
            when: () => {
                return { status: "draft" };
            },
        });
        const { args, writer } = recording(createRawWriter([{ _id: "post_1", table: "posts" }], []));
        const guarded = guard(writer, protectedTables, tableOfId);
        const handler = lunora.query
            .use(rlsForTest<TestContext>(definePolicies([tenantPosts])))
            .use(rlsForTest<TestContext>(definePolicies([draftsOnly])))
            .query(async ({ ctx }) => ctx.db.findMany("posts"));

        await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        expect(args[0]).toMatchObject({ baseWhere: { AND: [{ ownerId: "u1" }, { status: "draft" }] } });
    });

    it("routes a table only the SECOND step gates around the guard", async () => {
        expect.assertions(1);

        const log: string[] = [];
        const guarded = guard(createRawWriter([{ _id: "secret_1", table: "secrets" }], log), protectedTables, tableOfId);
        const handler = lunora.query
            .use(rlsForTest<TestContext>(definePolicies([tenantPosts])))
            .use(rlsForTest<TestContext>(definePolicies([readSecrets])))
            .query(async ({ ctx }) => ctx.db.findMany("secrets"));

        await handler.handler({ auth: { userId: "u1" }, db: guarded }, {});

        expect(log).toContain("raw.findMany:secrets");
    });

    it("requires a write to satisfy every step that gates the table", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const permissive = definePolicies([
            definePolicy<TestContext>({ on: "read", table: "posts", when: () => true }),
            definePolicy<TestContext>({ on: "update", table: "posts", when: () => true }),
        ]);
        const restrictive = definePolicies([
            definePolicy<TestContext>({ on: "read", table: "posts", when: () => true }),
            definePolicy<TestContext>({ on: "update", table: "posts", when: () => false }),
        ]);
        const guarded = guard(createRawWriter([{ _id: "post_1", table: "posts" }], log), protectedTables, tableOfId);
        const handler = lunora.mutation
            .use(rlsForTest<TestContext>(permissive))
            .use(rlsForTest<TestContext>(restrictive))
            .mutation(async ({ ctx }) => ctx.db.patch("post_1", { title: "x" }));

        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).rejects.toThrow(/denied by policy/u);

        expect(log).not.toContain("raw.patch:post_1");
    });
});
