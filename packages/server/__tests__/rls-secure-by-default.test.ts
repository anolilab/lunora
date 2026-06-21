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

    return {
        ...raw,
        [RLS_UNWRAP_SYMBOL]: raw,
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
    } as unknown as RawWriter;
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

    it("keeps LunoraError importable for downstream policy-denial assertions", () => {
        expect.assertions(1);

        expect(LunoraError).toBeTypeOf("function");
    });
});
