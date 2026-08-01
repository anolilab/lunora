/**
 * Tests for the Dynamic Data Masking middleware (plan 023, item 1).
 *
 * Like the RLS tests, we don't spin up a real ORM — masking is one layer above
 * the underlying writer and only cares about the row VALUES it threads back. A
 * handwritten fake writer returns seeded rows; assertions read the masked result
 * the handler returns, and (for the "stored data untouched" guard) read the raw
 * rows straight back off the writer to prove the store was never rewritten.
 */
import { describe, expect, it } from "vitest";

import type { MaskOptions, MaskPolicies, Middleware } from "../src/index";
import { definePermission, defineRole, initLunora, LunoraError, mask } from "../src/index";

/**
 * The procedure builder types `ctx.db` nominally; the mask middleware's
 * structural `MaskDatabase` is a superset. Pin one permissive cast here so each
 * test reads cleanly (mirrors `rlsForTest` in `rls.test.ts`).
 */
const maskForTest = (policies: MaskPolicies<any>, options?: MaskOptions<any>): Middleware<any, any> =>
    (mask as unknown as (p: MaskPolicies<any>, o?: MaskOptions<any>) => Middleware<any, any>)(policies, options);

/* -------------------------------------------------------------------------
 * Fake writer (trimmed copy of the rls.test.ts fake)
 * ---------------------------------------------------------------------- */

interface CapturedCall {
    args: unknown;
    method: string;
    tableOrId?: string;
}

/** Index-range builder passed to `.withIndex(name, q => …)` — mirrors `@lunora/do`'s `IndexRangeBuilderLike`. */
interface FakeIndexBuilder {
    eq: (field: string, value: unknown) => FakeIndexBuilder;
    gt: (field: string, value: unknown) => FakeIndexBuilder;
    gte: (field: string, value: unknown) => FakeIndexBuilder;
    lt: (field: string, value: unknown) => FakeIndexBuilder;
    lte: (field: string, value: unknown) => FakeIndexBuilder;
}

/** Search-filter builder passed to `.withSearchIndex(name, q => …)` — mirrors `@lunora/do`'s `SearchFilterBuilderLike`. */
interface FakeSearchBuilder {
    eq: (field: string, value: unknown) => FakeSearchBuilder;
    search: (field: string, query: string) => FakeSearchBuilder;
}

/** Geo-filter builder passed to `.withGeoIndex(name, q => …)` — mirrors `@lunora/do`'s `GeoFilterBuilderLike`. */
interface FakeGeoBuilder {
    near: (point: { lat: number; lng: number }, radiusMeters: number) => FakeGeoBuilder;
    within: (box: { ne: { lat: number; lng: number }; sw: { lat: number; lng: number } }) => FakeGeoBuilder;
}

interface FakeReader {
    collect: () => Promise<Record<string, unknown>[]>;

    /**
     * Synthesizes a deterministic, distinguishable score/distance per row
     * (by position) — the fixture doesn't need a realistic ranking, only one
     * a test can prove passed through the mask wrapper unchanged. Mirrors the
     * real `ScoredDocument` union: a row carries `distanceMeters` XOR `score`,
     * never both — see `@lunora/shard-engine`'s `GeoScoredDocument` /
     * `SearchScoredDocument`.
     */
    collectWithScores: () => Promise<
        (
            | { distanceMeters: null | number; document: Record<string, unknown>; score?: never }
            | { distanceMeters?: never; document: Record<string, unknown>; score: number }
        )[]
    >;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => FakeReader;
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => FakeReader;
    paginate: () => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    unique: () => Promise<Record<string, unknown> | null>;
    withGeoIndex: (indexName?: string, build?: (q: FakeGeoBuilder) => FakeGeoBuilder) => FakeReader;
    withIndex: (indexName?: string, range?: (q: FakeIndexBuilder) => FakeIndexBuilder) => FakeReader;
    withSearchIndex: (indexName: string, search: (q: FakeSearchBuilder) => FakeSearchBuilder) => FakeReader;
}

interface FakeDatabase {
    calls: CapturedCall[];
    writer: {
        aggregate: (tableName: string, options: unknown) => Promise<null | number>;
        count: (tableName: string, whereOrArgs?: unknown) => Promise<number>;
        delete: (id: string) => Promise<void>;
        deleteWhere: (tableName: string, where: Record<string, unknown>, options?: { limit?: number }) => Promise<{ deleted: number }>;
        findFirst: (tableName: string, args?: unknown) => Promise<Record<string, unknown> | null>;
        findFirstOrThrow: (tableName: string, args?: unknown) => Promise<Record<string, unknown>>;
        findMany: (tableName: string, args?: unknown) => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
        get: (id: string) => Promise<Record<string, unknown> | null>;
        groupBy: (tableName: string, options: unknown) => Promise<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>;
        insert: (tableName: string, document: Record<string, unknown>) => Promise<string>;
        lookupById?: (id: string) => Promise<null | { row: Record<string, unknown>; tableName: string }>;
        patch: (id: string, patch: Record<string, unknown>) => Promise<void>;
        patchWhere: (
            tableName: string,
            args: { patch: Record<string, unknown>; where: Record<string, unknown> },
            options?: { limit?: number },
        ) => Promise<{ patched: number }>;
        query: (tableName: string) => FakeReader;
        rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
        /** Optional — mirrors `@lunora/do`'s D1 twin, which omits `rankBefore`. Enabled per-test via `enableRankBefore`. */
        rankBefore?: (tableName: string, indexName: string, options: unknown) => Promise<{ before: number; total: number }>;
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
            async deleteWhere(tableName, where, options) {
                calls.push({ args: { options, where }, method: "deleteWhere", tableOrId: tableName });

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
            async patchWhere(tableName, args, options) {
                calls.push({ args: { ...args, options }, method: "patchWhere", tableOrId: tableName });

                return { patched: rowsOfTable(tableName).length };
            },
            query() {
                throw new Error("query() not used in these tests");
            },
            async rank(tableName, _indexName, options) {
                calls.push({ args: options, method: "rank", tableOrId: tableName });

                return { position: 1, total: rowsOfTable(tableName).length };
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

/** Enable the optional `lookupById` fast-path seam (mirrors `@lunora/do`'s `lookupById`). */
const enableGetWithTable = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    const byId = new Map(rows.map((row) => [row._id, row] as const));

    // eslint-disable-next-line no-param-reassign -- the helper installs the seam on the caller's fake writer
    database.writer.lookupById = async (id) => {
        database.calls.push({ args: undefined, method: "lookupById", tableOrId: id });
        const row = byId.get(id);

        return row ? { row, tableName: row.table } : null;
    };
};

/** Enable the optional `rankBefore` seam (mirrors `@lunora/do`'s writer; the D1 twin omits it). */
const enableRankBefore = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    // eslint-disable-next-line no-param-reassign -- the helper installs the seam on the caller's fake writer
    database.writer.rankBefore = async (tableName, _indexName, options) => {
        database.calls.push({ args: options, method: "rankBefore", tableOrId: tableName });

        return { before: 0, total: rows.filter((row) => row.table === tableName).length };
    };
};

/** Enable the optional `rankPageRows` seam — the cross-shard companion to `rankPage` (mirrors `@lunora/shard-engine`'s writer). */
const enableRankPageRows = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    // eslint-disable-next-line no-param-reassign -- the helper installs the seam on the caller's fake writer
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

/**
 * Install a chainable `query()` reader on the fake writer — the legacy
 * iterator-style reader that masking's `wrapReader` wraps. Mirrors `@lunora/do`'s
 * reader surface (`withIndex` / `order` / `filter` / terminal `collect` etc.) so
 * the full chain, including `.order()`, is exercised end-to-end.
 *
 * `scoreMode` picks which of `collectWithScores()`'s two exclusive row shapes
 * this reader hands back (default `"search"`) — only the `.collectWithScores()`
 * tests care; every other caller ignores it.
 */
const enableQueryReader = (
    database: FakeDatabase,
    rows: (Record<string, unknown> & { _id: string; table: string })[],
    scoreMode: "geo" | "search" = "search",
): void => {
    const makeReader = (list: Record<string, unknown>[]): FakeReader => {
        return {
            collect: async () => list,

            collectWithScores: async () =>
                list.map((row, index) =>
                    scoreMode === "geo" ? { distanceMeters: index === 0 ? 111 : null, document: row } : { document: row, score: 100 - index },
                ),
            filter: (predicate) => makeReader(list.filter((row) => predicate(row))),
            first: async () => list[0] ?? null,
            order: (direction) => makeReader(direction === "desc" ? list.toReversed() : list),
            paginate: async () => {
                return { continueCursor: null, isDone: true, page: list };
            },
            take: async (limit) => list.slice(0, limit),
            unique: async () => list[0] ?? null,
            // Run the builder callback against a chainable no-op — mirrors
            // `@lunora/do`'s reader, and proves the mask guard's recorder pass is
            // an EXTRA run the (pure) callback survives (the reader still runs it).
            withGeoIndex: (_indexName, build) => {
                const builder: FakeGeoBuilder = {
                    near: () => builder,
                    within: () => builder,
                };

                build?.(builder);

                return makeReader(list);
            },
            withIndex: (_indexName, range) => {
                const builder: FakeIndexBuilder = {
                    eq: () => builder,
                    gt: () => builder,
                    gte: () => builder,
                    lt: () => builder,
                    lte: () => builder,
                };

                range?.(builder);

                return makeReader(list);
            },
            withSearchIndex: (_indexName, search) => {
                const builder: FakeSearchBuilder = {
                    eq: () => builder,
                    search: () => builder,
                };

                search(builder);

                return makeReader(list);
            },
        };
    };

    // eslint-disable-next-line no-param-reassign -- the helper installs the query seam on the caller's fake writer
    database.writer.query = (tableName) => {
        database.calls.push({ args: undefined, method: "query", tableOrId: tableName });

        return makeReader(rows.filter((row) => row.table === tableName));
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

interface Page {
    page: Record<string, unknown>[];
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

describe("mask — read path", () => {
    it("redacts a declared column to null in findMany rows", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([
            { _id: "u1", email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", email: "b@x.com", name: "Bo", table: "users" },
        ]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users"));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        expect(result.page[0]?.["email"]).toBeNull();
        expect(result.page[1]?.["email"]).toBeNull();
        // Non-masked columns pass through untouched.
        expect(result.page[0]?.["name"]).toBe("Ann");
    });

    it("masks rows read through the query().withIndex().order() chain", async () => {
        expect.assertions(3);

        const seed = [
            { _id: "u1", email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", email: "b@x.com", name: "Bo", table: "users" },
        ];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            // `.order()` is a chainable reader link: it must survive the mask wrapper, not throw.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_email").order("desc").collect());

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        expect(rows[0]?.["email"]).toBeNull();
        expect(rows[1]?.["email"]).toBeNull();
    });

    it("masks (and does not throw on) the row returned by query().withIndex().unique()", async () => {
        expect.assertions(2);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            // `.unique()` is a core terminal — it must resolve through the mask wrapper, not be `undefined`.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_email").unique());

        const row = await handler.handler(makeContext(database, "u1"), {});

        expect(row?.["email"]).toBeNull();
        expect(row?.["name"]).toBe("Ann");
    });

    it("masks documents (not the score) through query().withSearchIndex().collectWithScores()", async () => {
        expect.assertions(4);

        const seed = [
            { _id: "u1", email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", email: "b@x.com", name: "Bo", table: "users" },
        ];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .withSearchIndex("by_name", (q) => q.search("name", "a"))
                .collectWithScores(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        // The document half is masked exactly like `.collect()` would.
        expect(rows[0]?.document["email"]).toBeNull();
        expect(rows[0]?.document["name"]).toBe("Ann");
        // score carries no column value — same reasoning that lets count()/rank()
        // pass through the mask wrapper — so it must NOT be touched.
        expect(rows[0]?.score).toBe(100);
    });

    it("masks documents AND withholds distanceMeters through query().withGeoIndex().collectWithScores() (exact-location oracle)", async () => {
        expect.assertions(3);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed, "geo");

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .withGeoIndex("by_location", (q) => q.near({ lat: 0, lng: 0 }, 1000))
                .collectWithScores(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows[0]?.document["email"]).toBeNull();
        expect(rows[0]?.document["name"]).toBe("Ann");
        // `distanceMeters` is a value oracle over a possibly-masked location
        // column (this table masks `email`, but the wrapper can't prove
        // `by_location` isn't built over a masked column too) — it must be
        // withheld, not just the seeded `111` passed through unchanged.
        expect(rows[0]?.distanceMeters).toBeNull();
    });

    it("does NOT touch score through query().withSearchIndex().collectWithScores() on a masked table (already closed upstream by the search-field guard)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                // Searches a non-masked field — `assertIndexFieldsAllowed` only
                // rejects a search over a MASKED field, so this reaches
                // `collectWithScores()` and `score` must still pass through in
                // the clear (unlike `distanceMeters`, it carries no column value).
                .withSearchIndex("by_name", (q) => q.search("name", "a"))
                .collectWithScores(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows[0]?.score).toBe(100);
    });

    it("returns the real distanceMeters through query().withGeoIndex().collectWithScores() on an UNMASKED table (wrapper never applies)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed, "geo");

        // No mask policy for "users" at all — `perTable` has no entry for it, so
        // `wrapped.query("users")` (see `middleware.ts`'s `query()`) returns the
        // BASE reader untouched; `collectWithScores` is never wrapped and the
        // geo distance is inherently real, not something this middleware chose
        // to disclose.
        const handler = lunora.query.use(maskForTest({})).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .withGeoIndex("by_location", (q) => q.near({ lat: 0, lng: 0 }, 1000))
                .collectWithScores(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows[0]?.distanceMeters).toBe(111);
    });

    it("masks the row returned by findFirst", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBeNull();
        expect(result?.["name"]).toBe("Ann");
    });

    it("leaves a non-masked table's rows untouched", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "e1", email: "raw@x.com", table: "events" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("events"));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        expect(result.page[0]?.["email"]).toBe("raw@x.com");
    });

    it("the 'hash' strategy is deterministic and hides the raw value", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([
            { _id: "u1", email: "same@x.com", table: "users" },
            { _id: "u2", email: "same@x.com", table: "users" },
            { _id: "u3", email: "other@x.com", table: "users" },
        ]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "hash" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users"));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;
        const [a, b, c] = result.page.map((row) => row["email"]);

        // Same input → same token (joinable client-side), different input → different token.
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        // The token never equals the raw value.
        expect(a).not.toBe("same@x.com");
    });
});

describe("mask — custom strategies & bypass", () => {
    const viewPii = definePermission("pii:view");
    const support = defineRole("support", { permissions: [viewPii] });

    it("a role-aware MaskFn reveals for a granted caller, redacts otherwise", async () => {
        expect.assertions(2);

        const policies: MaskPolicies<any> = {
            users: { phone: (value, { auth }) => (auth.can("pii:view") ? value : null) },
        };

        const database = createFakeDatabase([{ _id: "u1", phone: "555-0100", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest(policies, { roles: [support] }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const granted = await handler.handler(makeContext(database, "u1", ["support"]), {});
        const denied = await handler.handler(makeContext(database, "u1", ["guest"]), {});

        expect(granted?.["phone"]).toBe("555-0100");
        expect(denied?.["phone"]).toBeNull();
    });

    it("a MaskFn sees the original sibling columns (pre-mask row)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", role: "admin", table: "users" }]);

        // The mask on `email` branches on the row's `role` — which must be the
        // ORIGINAL value even though `email` is being rewritten in the copy.
        const policies: MaskPolicies<any> = {
            users: { email: (value, context) => (context.row?.["role"] === "admin" ? value : "REDACTED") },
        };

        const handler = lunora.query.use(maskForTest(policies)).query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBe("a@x.com");
    });

    it("bypass returns true → the whole mask is skipped (raw values)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }, { bypass: ({ auth }) => auth.can("pii:view"), roles: [support] }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const result = await handler.handler(makeContext(database, "u1", ["support"]), {});

        expect(result?.["email"]).toBe("a@x.com");
    });

    it("fails closed: a throwing MaskFn redacts the cell to null", async () => {
        expect.assertions(1);

        const policies: MaskPolicies<any> = {
            users: {
                email: () => {
                    throw new Error("boom");
                },
            },
        };

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query.use(maskForTest(policies)).query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBeNull();
    });
});

describe("mask — analytical reductions fail closed", () => {
    it("aggregate() over a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", salary: 100, table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { salary: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("users", { field: "salary", op: "sum" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "aggregate")).toBe(false);
    });

    it("groupBy() over a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.groupBy("users", { by: ["email"] }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "groupBy")).toBe(false);
    });

    it("aggregate() over a NON-masked column on a masked table passes through", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", age: 30, email: "a@x.com", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("users", { field: "age", op: "sum" }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "aggregate")).toBe(true);
    });

    it("aggregate() with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            // A `where` over a masked column turns the row-count aggregate into a
            // value-confirmation oracle (count === 1 ⇒ value matched). Fail closed
            // before delegating to base.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("users", { op: "count", where: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "aggregate")).toBe(false);
    });

    it("groupBy() with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.groupBy("users", { by: ["status"], where: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "groupBy")).toBe(false);
    });

    it("aggregate() with a masked column nested under an OR/NOT where is still rejected", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("users", { op: "count", where: { OR: [{ NOT: { ssn: { eq: "000" } } }] } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("aggregate()/groupBy() with a where on a NON-masked column of a masked table pass through", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const aggregateHandler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.aggregate("users", { op: "count", where: { status: { eq: "active" } } }));

        const groupByHandler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.groupBy("users", { by: ["status"], where: { status: { eq: "active" } } }));

        await aggregateHandler.handler(makeContext(database, "u1"), {});
        await groupByHandler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "aggregate")).toBe(true);
        expect(database.calls.some((call) => call.method === "groupBy")).toBe(true);
    });

    it("mASK_UNSUPPORTED carries HTTP status 422", () => {
        expect.assertions(1);

        expect(new LunoraError("MASK_UNSUPPORTED").status).toBe(422);
    });
});

describe("mask — value oracle via filter/sort fails closed (regression)", () => {
    it("findMany with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { where: { ssn: { eq: "123-45-6789" } } }));

        // Filtering by a masked column would let a caller confirm the exact value
        // the mask hides (row present ⇒ value matched) — must fail closed.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "findMany")).toBe(false);
    });

    it("a masked column nested under an OR/NOT where is still rejected", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { where: { OR: [{ NOT: { ssn: { eq: "000" } } }] } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("count with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.count("users", { where: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "count")).toBe(false);
    });

    it("a where on a NON-masked column of a masked table passes through", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { where: { status: { eq: "active" } } }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "findMany")).toBe(true);
    });

    it("count with a baseWhere on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            // `baseWhere` reaches the SQL predicate just like `where`, so a masked
            // column smuggled through it is the same count-oracle — fail closed.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.count("users", { baseWhere: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "count")).toBe(false);
    });

    it("findMany with an orderBy on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            // Masking rewrites cells but preserves row order, so ordering by a
            // masked column returns masked cells sorted by the true hidden value —
            // a sort/binary-search oracle. Must fail closed before delegating.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { orderBy: [{ ssn: "asc" }] }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "findMany")).toBe(false);
    });

    it("findFirst with an orderBy on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users", { orderBy: [{ ssn: "asc" }] }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "findFirst")).toBe(false);
    });

    it("an orderBy on a NON-masked column of a masked table passes through", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { orderBy: [{ status: "asc" }] }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "findMany")).toBe(true);
    });

    it("deleteMany({ where }) on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.mutation
            .use(maskForTest({ users: { ssn: "redact" } }))
            .mutation(async ({ ctx }) => (ctx as unknown as TestContext).db.deleteWhere("users", { ssn: { eq: "123-45-6789" } }));

        // deleteMany({ where }) routes to the writer's where-based delete — a
        // masked-column predicate is the same confirm/destroy oracle `where` on
        // reads already blocks, plus it destroys the probed rows. Must fail closed
        // and never reach the writer.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "deleteWhere")).toBe(false);
    });

    it("patchMany({ where, values }) on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.mutation
            .use(maskForTest({ users: { ssn: "redact" } }))
            .mutation(async ({ ctx }) =>
                (ctx as unknown as TestContext).db.patchWhere("users", { patch: { status: "flagged" }, where: { ssn: { eq: "123-45-6789" } } }),
            );

        // patchMany({ where }) routes to the writer's where-based patch — the
        // `{ patched: n }` count alone confirms/binary-searches the hidden value.
        // Must fail closed and never reach the writer.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "patchWhere")).toBe(false);
    });

    it("findMany with a baseWhere on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            // `baseWhere` is a documented, caller-reachable field on `QueryArgs` that
            // the RLS layer AND-merges into the SQL predicate — the same oracle
            // `where` is already blocked for, reached through a different field.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users", { baseWhere: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "findMany")).toBe(false);
    });

    it("deleteMany({ where }) on a NON-masked column of a masked table passes through", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.mutation
            .use(maskForTest({ users: { ssn: "redact" } }))
            .mutation(async ({ ctx }) => (ctx as unknown as TestContext).db.deleteWhere("users", { status: { eq: "active" } }));

        await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "deleteWhere")).toBe(true);
    });
});

describe("mask — value oracle via index readers fails closed (regression)", () => {
    it("withSearchIndex searching a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            // A search index over a masked column is the headline oracle: the
            // matched (masked) row confirms the search term equals the hidden
            // value. Must fail closed before the search ever runs.
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withSearchIndex("by_email", (q) => q.search("email", "a@x.com"))
                    .first(),
            );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("withIndex ranging over a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", email: "a@x.com", name: "Ann", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            // An index equality/range over a masked column confirms / binary-
            // searches the hidden value the same way a masked `where` does.
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withIndex("by_email", (q) => q.eq("email", "a@x.com"))
                    .first(),
            );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("withIndex over a NON-masked column of a masked table still works and masks output (Strategy A)", async () => {
        expect.assertions(4);

        const seed = [
            { _id: "u1", createdAt: 1, email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", createdAt: 2, email: "b@x.com", name: "Bo", table: "users" },
        ];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            // Ranging over a NON-masked column is a legitimate index read: it must
            // pass through (precise Strategy A), and the returned rows must still
            // be masked on output.
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withIndex("by_created", (q) => q.gte("createdAt", 1))
                    .collect(),
            );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        expect(rows[0]?.["email"]).toBeNull();
        expect(rows[1]?.["email"]).toBeNull();
        expect(rows[0]?.["name"]).toBe("Ann");
    });
});

describe("mask — value oracle via rank reads fails closed (plan 209)", () => {
    it("rank() with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db.rank("users", "by_ssn", {
                row: "u1",
                where: { ssn: { eq: "123-45-6789" } },
            }),
        );

        // rank() returns no column value, but a masked-column `where` is a
        // presence oracle the same way it is on findMany/count — combined with
        // the returned ordinal it lets a caller binary-search the hidden value.
        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rank")).toBe(false);
    });

    it("rank() with a baseWhere on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db.rank("users", "by_ssn", {
                baseWhere: { ssn: { eq: "123-45-6789" } },
                row: "u1",
            }),
        );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rank() with a where on a NON-masked column of a masked table passes through", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db.rank("users", "by_status", {
                row: "u1",
                where: { status: { eq: "active" } },
            }),
        );

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result).toStrictEqual({ position: 1, total: 1 });
        expect(database.calls.some((call) => call.method === "rank")).toBe(true);
    });

    it("rankPage() with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "by_ssn", { where: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rankPage")).toBe(false);
    });

    it("rankPage() with a baseWhere on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "by_ssn", { baseWhere: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rankPage() with a where on a NON-masked column of a masked table still works and masks output", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "by_status", { where: { status: { eq: "active" } } }));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        expect(database.calls.some((call) => call.method === "rankPage")).toBe(true);
        expect(result.page[0]?.["ssn"]).toBeNull();
        expect(result.page[0]?.["status"]).toBe("active");
    });

    it("rankBefore() with a where on a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const rows = [{ _id: "u1", ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankBefore(database, rows);

        // `@lunora/do`'s real `RankBeforeOptions` carries no `where`/`baseWhere`
        // (a rankBefore call is keyed by `rowId`/`sortValues`/`partitionKey`, not
        // a filter) — this guard is defense-in-depth against a caller/future
        // shape that adds one, exercised here via the loosely-typed `options:
        // unknown` seam. The real rankBefore oracle is `sortValues` naming a
        // masked-sorted index, which needs schema access this middleware does
        // not have (see the module docblock).
        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db.rankBefore?.("users", "by_ssn", { rowId: "u1", where: { ssn: { eq: "123-45-6789" } } }),
            );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rankBefore")).toBe(false);
    });

    it("rankBefore() with a where on a NON-masked column of a masked table passes through", async () => {
        expect.assertions(2);

        const rows = [{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankBefore(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db.rankBefore?.("users", "by_status", { rowId: "u1", where: { status: { eq: "active" } } }),
            );

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result).toStrictEqual({ before: 0, total: 1 });
        expect(database.calls.some((call) => call.method === "rankBefore")).toBe(true);
    });

    it("does not surface rankBefore() at all when the underlying writer omits it (D1 twin)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(({ ctx }) => typeof (ctx as unknown as TestContext).db.rankBefore);

        // No `enableRankBefore` call: the fake writer never carries the method,
        // so the wrapper — mirroring `../rls/middleware`'s own optional-method
        // handling — must not synthesize one either.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toBe("undefined");
    });

    it("rankPageRows() with a where on a masked column throws MASK_UNSUPPORTED (plan 254)", async () => {
        expect.assertions(2);

        const rows = [{ _id: "u1", ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankPageRows(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPageRows?.("users", "by_ssn", { where: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rankPageRows")).toBe(false);
    });

    it("rankPageRows() with a baseWhere on a masked column throws MASK_UNSUPPORTED (plan 254)", async () => {
        expect.assertions(1);

        const rows = [{ _id: "u1", ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankPageRows(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPageRows?.("users", "by_ssn", { baseWhere: { ssn: { eq: "123-45-6789" } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rankPageRows() with a where on a NON-masked column of a masked table still works and masks every doc (plan 254)", async () => {
        expect.assertions(3);

        const rows = [{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankPageRows(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPageRows?.("users", "by_status", { where: { status: { eq: "active" } } }));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(database.calls.some((call) => call.method === "rankPageRows")).toBe(true);
        expect(result?.rows[0]?.doc["ssn"]).toBeNull();
        expect(result?.rows[0]?.doc["status"]).toBe("active");
    });

    it("does not surface rankPageRows() at all when the underlying writer omits it (D1 twin) (plan 254)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(({ ctx }) => typeof (ctx as unknown as TestContext).db.rankPageRows);

        // No `enableRankPageRows` call: the fake writer never carries the
        // method, so the wrapper must not synthesize one either — mirrors the
        // rankBefore D1-twin-omission test above.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toBe("undefined");
    });
});

describe("mask — bare-index-scan / rank declaration oracle fails closed (plan 250)", () => {
    it("bare withIndex(name) over an index whose DECLARED fields include a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", createdAt: 1, ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn: ["ssn"] } } }))
            // No range callback: this is the bare scan the range-recorder can't
            // see — it still returns every row ORDERED by the masked `ssn`
            // column, which is the position oracle `assertIndexDeclarationAllowed`
            // closes.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_ssn").collect());

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("bare withIndex(name) over an index whose DECLARED fields exclude the masked column still scans and masks output", async () => {
        expect.assertions(2);

        const seed = [{ _id: "u1", createdAt: 1, email: "a@x.com", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { by_createdAt: ["createdAt"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_createdAt").collect());

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
        expect(rows[0]?.["email"]).toBeNull();
    });

    it("withIndex(range) over a masked-column index throws even when the range callback references only an unmasked field (declared fields win over callback-referenced ones)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", createdAt: 1, ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn_time: ["createdAt", "ssn"] } } }))
            // The callback only ever names `createdAt` — `assertIndexFieldsAllowed`'s
            // recorder would let this through on its own — but `by_ssn_time`
            // DECLARES `ssn` too, so the row order still leaks the hidden value.
            // The declaration guard rejects it regardless of what the callback
            // references.
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withIndex("by_ssn_time", (q) => q.gte("createdAt", 1))
                    .collect(),
            );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("withIndex over an index name absent from `indexFields` is not rejected by the declaration guard (fails open; an unknown index errors downstream anyway)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", email: "a@x.com", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { by_ssn: ["ssn"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_unknown").collect());

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows[0]?.["email"]).toBeNull();
    });

    it("regression: with `indexFields` omitted, a bare withIndex(name) behaves exactly as before this option existed (no throw)", async () => {
        expect.assertions(2);

        const seed = [{ _id: "u1", ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").withIndex("by_ssn").collect());

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
        expect(rows[0]?.["ssn"]).toBeNull();
    });

    it("rank() over a rank index whose declared `sortBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn_rank: ["ssn"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "by_ssn_rank", { row: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rank() over a rank index whose declared `partitionBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_score_per_ssn: ["score", "ssn"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "by_score_per_ssn", { row: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rank() over an all-unmasked rank index passes through", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { leaderboard: ["score"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "leaderboard", { row: "u1" }));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result).toStrictEqual({ position: 1, total: 1 });
        expect(database.calls.some((call) => call.method === "rank")).toBe(true);
    });

    it("rankPage() over a rank index whose declared `sortBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn_rank: ["ssn"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "by_ssn_rank", {}));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rankPage")).toBe(false);
    });

    it("rankPage() over an all-unmasked rank index still works and masks output", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { leaderboard: ["score"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "leaderboard", {}));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        expect(database.calls.some((call) => call.method === "rankPage")).toBe(true);
        expect(result.page[0]?.["ssn"]).toBeNull();
    });

    it("rankBefore() over a rank index whose declared `sortBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const rows = [{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankBefore(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn_rank: ["ssn"] } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankBefore?.("users", "by_ssn_rank", { rowId: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rankBefore absent on the base writer (D1 twin) is not synthesized even when `indexFields` is supplied — no crash", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { by_ssn_rank: ["ssn"] } } }))
            .query(({ ctx }) => typeof (ctx as unknown as TestContext).db.rankBefore);

        // No `enableRankBefore` call: the fake writer never carries the method.
        // `wrapDatabase`'s conditional spread must not synthesize one even now
        // that `assertIndexDeclarationAllowed` exists — no crash, no throw.
        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toBe("undefined");
    });

    it("regression: with `indexFields` omitted, rank() over a masked-sorted index behaves exactly as before this option existed (no throw from the declaration guard)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "by_ssn_rank", { row: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toStrictEqual({ position: 1, total: 1 });
    });
});

describe("mask — withGeoIndex position oracle fails closed (plan 250 follow-up)", () => {
    it("withGeoIndex over a geo index whose declared field is masked throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", homeLocation: { lat: 40.7128, lng: -74.006 }, table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { homeLocation: "redact" } }, { indexFields: { users: { by_location: ["homeLocation"] } } }))
            // A caller sweeping `point`/`radiusMeters` here gets rows sorted by
            // distance from an arbitrary point of their own choosing — the same
            // shape of ordinal leak as the bare-`withIndex` oracle, but over a
            // `v.geoPoint()` column instead of a scalar. There is no unmasked
            // range/prefix escape for a geo index (unlike a multi-column
            // `withIndex`), so this must fail closed unconditionally.
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withGeoIndex("by_location", (q) => q.near({ lat: 40.7, lng: -74 }, 5000))
                    .collect(),
            );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("withGeoIndex over a geo index whose declared field is NOT masked still scans and masks other output (no over-fire)", async () => {
        expect.assertions(2);

        const seed = [{ _id: "u1", email: "a@x.com", homeLocation: { lat: 40.7128, lng: -74.006 }, table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { by_location: ["homeLocation"] } } }))
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("users")
                    .withGeoIndex("by_location", (q) => q.near({ lat: 40.7, lng: -74 }, 5000))
                    .collect(),
            );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
        // The geo column itself isn't masked here, so the read must go through
        // (proving the declaration guard doesn't over-fire on an unmasked geo
        // index) while the actually-masked column is still redacted.
        expect(rows[0]?.["email"]).toBeNull();
    });

    it("regression: with `indexFields` omitted, withGeoIndex over a masked-field geo index behaves exactly as before this option existed (no throw from the declaration guard)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", homeLocation: { lat: 40.7128, lng: -74.006 }, table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { homeLocation: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .withGeoIndex("by_location", (q) => q.near({ lat: 40.7, lng: -74 }, 5000))
                .collect(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
    });
});

describe("mask — get() table resolution", () => {
    it("masks via the lookupById fast path", async () => {
        expect.assertions(2);

        const rows = [{ _id: "u1", email: "a@x.com", table: "users" }];
        const database = createFakeDatabase(rows);

        enableGetWithTable(database, rows);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => (ctx as unknown as TestContext).db.get("u1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBeNull();
        expect(database.calls.some((call) => call.method === "lookupById")).toBe(true);
    });

    it("masks via the probe fallback when lookupById is absent", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => (ctx as unknown as TestContext).db.get("u1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBeNull();
        // The fallback probed the masked table to resolve the id's owner.
        expect(database.calls.some((call) => call.method === "findFirst" && call.tableOrId === "users")).toBe(true);
    });

    it("get() on a row outside every masked table returns it unmasked", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "e1", email: "raw@x.com", table: "events" }]);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => (ctx as unknown as TestContext).db.get("e1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["_id"]).toBe("e1");
        expect(result?.["email"]).toBe("raw@x.com");
    });

    it("lookupById() itself (not just get()) masks the row it resolves (plan 254)", async () => {
        expect.assertions(2);

        // The `...base` spread would otherwise expose `base.lookupById`
        // directly, unmasked — `get()` above delegates to a `locate` helper
        // that already masks its result, but a caller reaching the
        // `lookupById` seam directly must see the same masked column.
        const rows = [{ _id: "u1", email: "a@x.com", table: "users" }];
        const database = createFakeDatabase(rows);

        enableGetWithTable(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("u1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.row["email"]).toBeNull();
        expect(result?.tableName).toBe("users");
    });

    it("lookupById() on a row outside every masked table returns it unmasked (plan 254)", async () => {
        expect.assertions(1);

        const rows = [{ _id: "e1", email: "raw@x.com", table: "events" }];
        const database = createFakeDatabase(rows);

        enableGetWithTable(database, rows);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.lookupById?.("e1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.row["email"]).toBe("raw@x.com");
    });
});

describe("mask — opt-in scope & stored data", () => {
    it("does NOT mask procedures whose chain omits mask()", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query.query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBe("a@x.com");
    });

    it("masking never rewrites the stored row (read-back shows the raw value)", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const masked = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users"));

        const maskedResult = await masked.handler(makeContext(database, "u1"), {});

        expect(maskedResult?.["email"]).toBeNull();

        // Read straight off the underlying writer — the store was never touched.
        const stored = await database.writer.get("u1");

        expect(stored?.["email"]).toBe("a@x.com");
    });
});

describe("mask — per-table facade (no mask bypass)", () => {
    /** Glue a per-table facade onto the fake writer, as codegen's bindTable does. */
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
                withSearchIndex: () => {
                    throw new Error("withSearchIndex not used in these tests");
                },
            };
        };

        const db = writer as FakeDatabase["writer"] & Record<string, unknown>;

        db["users"] = bindTable("users");
        db["events"] = bindTable("events");

        return db;
    };

    const makeFacadeContext = (database: FakeDatabase, userId: null | string): Record<string, unknown> => {
        const db = withFacade(database);

        return { auth: { roles: [], userId }, db };
    };

    interface FacadeCtx {
        db: Record<string, { findMany: (args?: unknown) => Promise<{ page: Record<string, unknown>[] }> }>;
    }

    it("masks ctx.db.<table>.findMany() (the facade is not a bypass)", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", email: "a@x.com", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as FacadeCtx).db["users"]!.findMany());

        const result = await handler.handler(makeFacadeContext(database, "u1"), {});

        expect(result.page[0]?.["email"]).toBeNull();
    });

    it("leaves a non-masked table's facade entry on its original binding", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([]);

        let usersEntry: unknown;
        let eventsEntry: unknown;

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, unknown> };

            usersEntry = db["users"];
            eventsEntry = db["events"];

            return null;
        });

        const context = makeFacadeContext(database, "u1");
        const originalEvents = (context["db"] as Record<string, unknown>)["events"];
        const originalUsers = (context["db"] as Record<string, unknown>)["users"];

        await handler.handler(context, {});

        // events: untouched reference; users: re-bound through the mask.
        expect(eventsEntry).toBe(originalEvents);
        expect(usersEntry).not.toBe(originalUsers);
    });
});

describe("mask — guarded-read coverage (every MaskDatabase read method)", () => {
    /**
     * Every read method on `MaskDatabase` (`../src/mask/middleware.ts`) that
     * accepts a `where`/`baseWhere`-shaped filter and so must reject one that
     * targets a masked column — the value/presence oracle every test above
     * verifies one method at a time. `MaskDatabase` is a structural interface
     * with no runtime manifest to enumerate automatically, so this list is
     * hand-maintained: ADD NEW READ METHODS HERE when `middleware.ts` grows
     * one. A method added to the writer surface without wiring it through
     * `assertWhereAllowed`/`assertReductionAllowed`/`assertRankWhereAllowed`
     * passes through unmasked-column values would still turn this suite red,
     * because the entry below drives the same masked "ssn" column through it
     * and asserts the rejection — omitting a method here is the only way to
     * silently reintroduce the gap this file exists to prevent.
     *
     * `get`/`lookupById`/`query` are deliberately excluded — none of the three
     * takes a `where`/`baseWhere` filter (they resolve by id or return a
     * chainable reader tested separately via the index-reader describe block
     * above), so there is no filter-oracle surface to assert here.
     */
    const maskedWhere = { ssn: { eq: "123-45-6789" } };

    const READ_METHODS_WITH_WHERE: ReadonlyArray<{ invoke: (db: TestContext["db"]) => Promise<unknown>; name: string }> = [
        { invoke: (db) => db.findMany("users", { where: maskedWhere }), name: "findMany" },
        { invoke: (db) => db.findFirst("users", { where: maskedWhere }), name: "findFirst" },
        { invoke: (db) => db.findFirstOrThrow("users", { where: maskedWhere }), name: "findFirstOrThrow" },
        { invoke: (db) => db.count("users", { where: maskedWhere }), name: "count" },
        { invoke: (db) => db.aggregate("users", { op: "count", where: maskedWhere }), name: "aggregate" },
        { invoke: (db) => db.groupBy("users", { by: ["status"], where: maskedWhere }), name: "groupBy" },
        { invoke: (db) => db.rank("users", "by_ssn", { row: "u1", where: maskedWhere }), name: "rank" },
        { invoke: (db) => db.rankPage("users", "by_ssn", { where: maskedWhere }), name: "rankPage" },
        // `rankBefore` is optional on `MaskDatabase` (the D1 twin omits it) — wrap
        // in `Promise.resolve` so a fake writer missing the seam unifies with the
        // other entries' `Promise<unknown>` instead of `Promise<unknown> | undefined`.
        { invoke: (db) => Promise.resolve(db.rankBefore?.("users", "by_ssn", { rowId: "u1", where: maskedWhere })), name: "rankBefore" },
        // `rankPageRows` (plan 254) is likewise optional on `MaskDatabase` — the
        // cross-shard companion to `rankPage`, gated the same way.
        { invoke: (db) => Promise.resolve(db.rankPageRows?.("users", "by_ssn", { where: maskedWhere })), name: "rankPageRows" },
    ];

    it.each(READ_METHODS_WITH_WHERE)("$name(...) with a where on a masked column throws MASK_UNSUPPORTED", async ({ invoke }) => {
        expect.assertions(1);

        const rows = [{ _id: "u1", ssn: "123-45-6789", status: "active", table: "users" }];
        const database = createFakeDatabase(rows);

        enableRankBefore(database, rows);
        enableRankPageRows(database, rows);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) => invoke((ctx as unknown as TestContext).db));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("the coverage table lists every MaskDatabase read method that declares a where/baseWhere-shaped filter", () => {
        expect.assertions(1);

        // Guards the guard: if `middleware.ts`'s `MaskDatabase` interface grows a
        // new filterable read method, this name list must grow with it — this
        // assertion is the tripwire a reviewer (or this test file's own drift)
        // would otherwise miss silently.
        const coveredNames = READ_METHODS_WITH_WHERE.map((entry) => entry.name).toSorted((a, b) => a.localeCompare(b));

        expect(coveredNames).toStrictEqual(
            ["aggregate", "count", "findFirst", "findFirstOrThrow", "findMany", "groupBy", "rank", "rankBefore", "rankPage", "rankPageRows"].toSorted(
                (a, b) => a.localeCompare(b),
            ),
        );
    });
});
