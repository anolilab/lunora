/**
 * `ctx.db.related` under the `rls()` middleware — per-hop routing.
 *
 * A traversal DISCOVERS its tables as it walks, so the wrapper cannot `route()`
 * it up front the way it routes every other read. It therefore re-binds the walk
 * over a reader that routes each hop, and these tests pin the three verdicts
 * that reader must reproduce — the same three a NAMED read of each table gets
 * under a `.rls("required")` schema:
 *
 * - a table with a read policy is reachable through the unwrapped writer AND
 * filtered by that policy;
 * - a protected table with NO read policy is denied by the guard;
 * - a `.public()` table passes through the guard.
 *
 * Plus the two properties the seam exists for: a start row the policy hides
 * reads as absent, and an outer `mask()` step's per-hop hook is applied.
 *
 * The guard contract is mirrored inline (as `rls-secure-by-default.test.ts`
 * mirrors it) rather than imported — the fixture has no real schema. The
 * TRAVERSAL is the real one: the middleware runs `@lunora/shard-engine`'s
 * `findRelated` over the reader it builds, so these exercise the production walk
 * over a fake storage layer.
 */
import { describe, expect, it } from "vitest";

import type { Middleware, Policy } from "../src/index";
import { definePolicies, definePolicy, initLunora, rls } from "../src/index";

const rlsForTest = <Context>(policies: ReadonlyArray<Policy<Context>>): Middleware<any, any> =>
    (rls as unknown as (p: ReadonlyArray<Policy<Context>>) => Middleware<any, any>)(policies);

/** The cross-realm key `@lunora/shard-engine`'s `guardWriter` hangs the unwrapped writer off of. */
const RLS_UNWRAP_SYMBOL = Symbol.for("lunora.ctxdb.rls-unwrap");

/** Error shape the inline guard throws (mirrors `RlsRequiredError` structurally). */
class FakeRlsRequiredError extends Error {
    public readonly code = "RLS_REQUIRED";

    public readonly table: string;

    public constructor(table: string) {
        super(`ctx.db access to "${table}" is denied (.rls("required"))`);
        this.name = "RlsRequiredError";
        this.table = table;
    }
}

type Row = Record<string, unknown> & { _id: string };

/** The subset of `WhereInput` the fixture's rows are filtered by. */
type FakeWhere = Record<string, unknown>;

/**
 * The edges the fixture declares, named exactly as `deriveRelationEdges` names
 * them. `users` is the policy target an OUT hop reaches; `comments` the
 * protected holder with no policy; `audit` the `.public()` one.
 */
const relationEdges = [
    { array: false, column: "authorId", name: "posts.authorId", sourceTable: "posts", targetTable: "users" },
    { array: false, column: "postId", name: "audit.postId", sourceTable: "audit", targetTable: "posts" },
    { array: false, column: "postId", name: "comments.postId", sourceTable: "comments", targetTable: "posts" },
];

const seedRows: Record<string, Row[]> = {
    audit: [{ _id: "a1", action: "read", postId: "p1" }],
    comments: [{ _id: "c1", body: "hi", postId: "p1" }],
    posts: [
        { _id: "p1", authorId: "u1", secret: "s1", visibility: "public" },
        { _id: "p2", authorId: "u1", secret: "s2", visibility: "private" },
    ],
    users: [{ _id: "u1", name: "Ada" }],
};

/**
 * Evaluate one `where` clause against a row — the two shapes the traversal and
 * the policy base actually produce: scalar equality, and `{ in: [...] }` set
 * membership (every batched hop read is an `IN`).
 */
const matchesWhere = (row: Row, where: FakeWhere | undefined): boolean => {
    if (where === undefined) {
        return true;
    }

    return Object.entries(where).every(([field, condition]) => {
        const value = row[field];

        if (typeof condition === "object" && condition !== null && Array.isArray((condition as { in?: unknown[] }).in)) {
            return (condition as { in: unknown[] }).in.includes(value);
        }

        return value === condition;
    });
};

/**
 * A raw writer over the seeded rows that HONOURS `where`, `baseWhere` and
 * `limit` — a traversal's whole behaviour is those three interacting per hop, so
 * a writer that ignores them would prove nothing. Every read is logged with the
 * writer that serviced it, so routing is asserted rather than inferred.
 */
const createRawWriter = (log: string[]) => {
    const rowsOfTable = (tableName: string): Row[] => seedRows[tableName] ?? [];

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
        async findFirst(tableName: string, args?: { baseWhere?: FakeWhere; where?: FakeWhere }) {
            log.push(`raw.findFirst:${tableName}`);

            return rowsOfTable(tableName).find((row) => matchesWhere(row, args?.where) && matchesWhere(row, args?.baseWhere)) ?? null;
        },
        async findFirstOrThrow(tableName: string) {
            log.push(`raw.findFirstOrThrow:${tableName}`);

            return rowsOfTable(tableName)[0] ?? null;
        },
        async findMany(tableName: string, args?: { baseWhere?: FakeWhere; limit?: number; where?: FakeWhere }) {
            log.push(`raw.findMany:${tableName}`);
            const matched = rowsOfTable(tableName).filter((row) => matchesWhere(row, args?.where) && matchesWhere(row, args?.baseWhere));
            const page = args?.limit === undefined ? matched : matched.slice(0, args.limit);

            return { continueCursor: null, isDone: page.length === matched.length, page };
        },
        async get(id: string) {
            log.push(`raw.get:${id}`);

            return (
                Object.values(seedRows)
                    .flat()
                    .find((row) => row._id === id) ?? null
            );
        },
        async groupBy(tableName: string) {
            log.push(`raw.groupBy:${tableName}`);

            return [{ key: {}, value: rowsOfTable(tableName).length }];
        },
        async insert(tableName: string) {
            log.push(`raw.insert:${tableName}`);

            return "new-id";
        },
        async lookupById(id: string) {
            log.push(`raw.lookupById:${id}`);
            const entry = Object.entries(seedRows).find(([, rows]) => rows.some((row) => row._id === id));

            if (entry === undefined) {
                return null;
            }

            const [tableName, rows] = entry;

            return { row: rows.find((row) => row._id === id) as Row, tableName };
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
        /** Published by the real writer alongside `related`; the wrapper keys the walk off it. */
        relationEdges,
        async replace(id: string) {
            log.push(`raw.replace:${id}`);
        },
    };
};

type RawWriter = ReturnType<typeof createRawWriter>;

/** Every fixture table but `audit`, which stands in for a `.public()` opt-out. */
const PROTECTED_TABLES = new Set(["comments", "posts", "users"]);

/**
 * Wrap a raw writer in a guard mirroring `guardWriter`: table-gated methods
 * throw for a protected table, and the unwrapped writer hangs off
 * `RLS_UNWRAP_SYMBOL`.
 *
 * The guard LOGS each gated call before delegating, so a test can tell "routed
 * THROUGH the guard" (the `.public()` verdict) from "routed AROUND it via `raw`"
 * (the policy-table verdict) instead of inferring it from the absence of a
 * throw.
 */
const guard = (raw: RawWriter, log: string[]): RawWriter => {
    const gate = (tableName: string, method: string): void => {
        log.push(`guard.${method}:${tableName}`);

        if (PROTECTED_TABLES.has(tableName)) {
            throw new FakeRlsRequiredError(tableName);
        }
    };

    const guarded = {
        ...raw,
        findMany: async (tableName: string, args?: { baseWhere?: FakeWhere; limit?: number; where?: FakeWhere }) => {
            gate(tableName, "findMany");

            return raw.findMany(tableName, args);
        },
        lookupById: async (id: string) => {
            const located = await raw.lookupById(id);

            if (located !== null) {
                gate(located.tableName, "lookupById");
            }

            return located;
        },
    };

    // NON-enumerable, mirroring the real `guardWriter`: an enumerable escape
    // hatch would ride the `{ ...ctx.db }` spread the RLS wrapper is built from.
    Object.defineProperty(guarded, RLS_UNWRAP_SYMBOL, { configurable: true, enumerable: false, value: raw });

    return guarded;
};

/** One fresh read log per test, shared by the raw writer and the guard over it. */
const guardedWriter = (log: string[]): RawWriter => guard(createRawWriter(log), log);

const lunora = initLunora.dataModel<Record<string, never>>().create();

interface TestContext {
    auth: { userId: null | string };
    db: RawWriter;
}

/** `posts` is policy-gated and NARROWED — only public posts are visible. */
const readPosts = definePolicy<TestContext>({
    on: "read",
    table: "posts",
    when: () => {
        return { visibility: "public" };
    },
});

/** `users` is policy-gated but UNRESTRICTED — it must still route around the guard. */
const readUsers = definePolicy<TestContext>({
    on: "read",
    table: "users",
    when: () => true,
});

/** Options a handler forwards to `ctx.db.related`, erased past the builder's `ctx` typing. */
type RelatedCall = (start: unknown, options?: Record<string, unknown>) => Promise<{ nodes: { document: Record<string, unknown>; table: string }[] }>;

const runRelated = async (
    database: RawWriter,
    policies: ReadonlyArray<Policy<TestContext>>,
    start: unknown,
    options?: Record<string, unknown>,
): Promise<{ nodes: { document: Record<string, unknown>; table: string }[] }> => {
    const handler = lunora.query
        .use(rlsForTest<TestContext>(definePolicies(policies)))
        .query(async ({ ctx }) => (ctx.db as unknown as { related: RelatedCall }).related(start, options));

    return handler.handler({ auth: { userId: "u1" }, db: database }, {});
};

describe("rls — ctx.db.related routes every hop", () => {
    it("reaches a POLICY table through the unwrapped writer and filters it by the policy", async () => {
        expect.assertions(3);

        const log: string[] = [];
        const guarded = guardedWriter(log);

        // In-hop `posts.authorId` from `u1` reads `posts WHERE authorId IN ("u1")`.
        // Both posts hold that author; only the public one survives the policy.
        const page = await runRelated(guarded, [readPosts, readUsers], { id: "u1", table: "users" }, { direction: "in", edges: ["posts.authorId"] });

        expect(page.nodes.map((node) => node.document._id)).toStrictEqual(["p1"]);
        // Routed AROUND the guard — a guarded `findMany` on `posts` would have thrown.
        expect(log).toContain("raw.findMany:posts");
        expect(log).not.toContain("guard.findMany:posts");
    });

    it("denies a hop into a protected table that declares no read policy", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const guarded = guardedWriter(log);

        // `comments` is protected and carries no policy in this bundle, so the
        // hop into it gets the same verdict a direct `findMany("comments")` gets.
        await expect(runRelated(guarded, [readPosts], { id: "p1", table: "posts" }, { direction: "in", edges: ["comments.postId"] })).rejects.toThrow(
            FakeRlsRequiredError,
        );

        expect(log).not.toContain("raw.findMany:comments");
    });

    it("reaches a .public() table through the guard", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const guarded = guardedWriter(log);

        const page = await runRelated(guarded, [readPosts], { id: "p1", table: "posts" }, { direction: "in", edges: ["audit.postId"] });

        expect(page.nodes.map((node) => node.document._id)).toStrictEqual(["a1"]);
        // Through the GUARD, not around it: `audit` has no policy, so it routes
        // to `base` and passes only because it is not protected.
        expect(log).toContain("guard.findMany:audit");
    });

    it("reads a start row the policy hides as absent", async () => {
        expect.assertions(1);

        const guarded = guardedWriter([]);

        // `p2` exists but is private, so the policy base excludes it. The walk
        // must report it missing rather than hand back its neighbourhood.
        await expect(runRelated(guarded, [readPosts, readUsers], { id: "p2", table: "posts" }, { edges: ["posts.authorId"] })).rejects.toThrow(
            /no "posts" row with id p2/u,
        );
    });

    it("resolves a loaded document's table through the unguarded lookup, then reads it routed", async () => {
        expect.assertions(2);

        const log: string[] = [];
        const guarded = guardedWriter(log);

        const page = await runRelated(guarded, [readPosts, readUsers], { _id: "p1", authorId: "u1" }, { direction: "out", edges: ["posts.authorId"] });

        expect(page.nodes.map((node) => node.table)).toStrictEqual(["users"]);
        // The table-name probe went through `raw` (it is not caller-visible
        // data); the rows behind it were still read through the routed reader.
        expect(log).toContain("raw.lookupById:p1");
    });

    it("applies an outer mask()'s per-hop hook to every reached row", async () => {
        expect.assertions(1);

        const guarded = guardedWriter([]);

        const page = await runRelated(
            guarded,
            [readPosts, readUsers],
            { id: "u1", table: "users" },
            {
                direction: "in",
                edges: ["posts.authorId"],
                relationMask: (table: string, rows: Record<string, unknown>[]) =>
                    table === "posts"
                        ? rows.map((row) => {
                              return { ...row, secret: "***" };
                          })
                        : rows,
            },
        );

        expect(page.nodes.map((node) => node.document.secret)).toStrictEqual(["***"]);
    });

    it("still walks and filters without the secure-by-default guard", async () => {
        expect.assertions(2);

        const log: string[] = [];
        // No guard: `base === raw`, so `route()` is a no-op and the SAME re-bound
        // walk has to keep behaving — this is the non-secure-by-default schema.
        const unguarded = createRawWriter(log);

        const page = await runRelated(unguarded, [readPosts, readUsers], { id: "u1", table: "users" }, { direction: "in", edges: ["posts.authorId"] });

        expect(page.nodes.map((node) => node.document._id)).toStrictEqual(["p1"]);
        expect(log).toContain("raw.findMany:posts");
    });
});
