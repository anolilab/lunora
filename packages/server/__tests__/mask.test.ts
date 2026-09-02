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

import { fnv1aHex } from "../../../shared/fnv1a";
import type { MaskOptions, MaskPolicies, Middleware } from "../src/index";
import { definePermission, defineRole, defineSchema, defineTable, indexFieldsFromSchema, initLunora, LunoraError, mask, v } from "../src/index";

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
    [Symbol.asyncIterator]: () => AsyncIterator<Record<string, unknown>>;
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
 * Mirrors `@lunora/shard-engine`'s `guardWriter` contract for `rankPageRows`
 * ONLY: the key is present on the returned writer if and only if `raw`
 * carries it — never unconditionally, and never as a stub that would
 * TypeError on a writer that omits it (the exact shape plan 254 restores;
 * see `rls-guard.test.ts`'s "optional analytical methods omitted..." suite for
 * the direct regression test against the real `guardWriter`). We don't import
 * `@lunora/shard-engine` here — wrong dependency direction, mirrors
 * `rls-secure-by-default.test.ts`'s own inline guard for the same reason.
 */
const withRlsGuardShape = (writer: FakeDatabase["writer"]): FakeDatabase["writer"] => {
    const { rankPageRows, ...rest } = writer;

    return rankPageRows ? { ...rest, rankPageRows } : rest;
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
            // eslint-disable-next-line generator-star-spacing -- prettier owns this spacing and formats it as `async *[…]`; the rule wants `async* […]`, and prettier runs last
            async *[Symbol.asyncIterator]() {
                yield* list;
            },
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
    auth: { getIdentity?: () => Promise<Record<string, unknown> | null>; userId: null | string };
    db: FakeDatabase["writer"];
}

/**
 * Roles reach a policy the ONLY way production can produce them: as the `roles`
 * claim on the resolved identity. There is no ctx-level `auth.roles` to set —
 * see `readIdentityRoles` in `rls/middleware.ts`.
 */
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

interface Page {
    page: Record<string, unknown>[];
}

/**
 * Inputs that exercise the `"hash"` strategy's wiring rather than the digest
 * itself: the empty string (loop never entered), a bigint's decimal form past
 * `Number.MAX_SAFE_INTEGER`, an ordinary value, a 4 KiB string (32-bit wraparound,
 * many times over), and a non-BMP code point. Expected digests are computed from
 * `shared/fnv1a.ts` — the SAME function the studio's mask preview calls — so this
 * asserts that the middleware routes the value through it unchanged, not what the
 * algorithm returns. The digest itself is pinned once, against edge-case inputs,
 * in `packages/studio/__tests__/features/data/data-browser-mask.test.tsx`
 * ("fnv1aHex > pins the digest for the algorithm's edge-case inputs").
 */
const HASH_INPUTS: ReadonlyArray<string> = ["", "9007199254740993", "ada@example.com", "x".repeat(4096), "\u{1F642} masked"];

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

    // Plan 270: the mask wrapper's reader object literal omitted
    // `[Symbol.asyncIterator]`, so `for await` threw `TypeError: … is not async
    // iterable` on any masked table's `query()` reader — even though the raw
    // and RLS-wrapped readers both keep it. The public `TableReader` type
    // (`types.ts`) promises the iterator unconditionally.
    it("yields masked rows through `for await` over query() (plan 270)", async () => {
        expect.assertions(3);

        const seed = [
            { _id: "u1", email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", email: "b@x.com", name: "Bo", table: "users" },
        ];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => {
            const rows: Record<string, unknown>[] = [];

            for await (const row of (ctx as unknown as TestContext).db.query("users")) {
                rows.push(row);
            }

            return rows;
        });

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        expect(rows[0]?.["email"]).toBeNull();
        expect(rows[1]?.["email"]).toBeNull();
    });

    it("yields masked rows through `for await` over a chained query().withIndex() (plan 270)", async () => {
        expect.assertions(3);

        const seed = [
            { _id: "u1", email: "a@x.com", name: "Ann", table: "users" },
            { _id: "u2", email: "b@x.com", name: "Bo", table: "users" },
        ];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        // The wrapper re-wraps on every chainable link — the iterator must
        // survive `.withIndex()`, not just the bare `query()` reader.
        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => {
            const rows: Record<string, unknown>[] = [];

            for await (const row of (ctx as unknown as TestContext).db.query("users").withIndex("by_email")) {
                rows.push(row);
            }

            return rows;
        });

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        expect(rows[0]?.["email"]).toBeNull();
        expect(rows[1]?.["email"]).toBeNull();
    });

    it("`for await` over an UNMASKED table's query() still works through the mask middleware (no regression)", async () => {
        expect.assertions(1);

        const seed = [{ _id: "p1", table: "posts", title: "hi" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        // No columns configured for "posts" → `wrapReader` is never installed
        // (`columns ? wrapReader(...) : reader`) — the raw reader's iterator
        // must still work.
        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => {
            const rows: Record<string, unknown>[] = [];

            for await (const row of (ctx as unknown as TestContext).db.query("posts")) {
                rows.push(row);
            }

            return rows;
        });

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
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

    // `JSON.stringify` throws on a bigint, so without an explicit case
    // `applyStrategy`'s fail-closed catch turned every `v.bigint()` cell into
    // `null` — silently losing the stable token `"hash"` exists for. The studio's
    // preview always hashed the decimal form; this is the server agreeing.
    it("hashes a bigint column over its decimal form instead of failing closed", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([
            { _id: "u1", balance: 9_007_199_254_740_993n, table: "users" },
            { _id: "u2", balance: 9_007_199_254_740_993n, table: "users" },
        ]);

        const handler = lunora.query
            .use(maskForTest({ users: { balance: "hash" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users"));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        // The same digest as hashing the decimal string — what the studio shows.
        expect(result.page[0]?.["balance"]).toBe(fnv1aHex("9007199254740993"));
        // Not the redaction sentinel the throwing `JSON.stringify` used to produce.
        expect(result.page[0]?.["balance"]).not.toBeNull();
        // Still deterministic: equal bigints hash equal, so the column stays groupable.
        expect(result.page[1]?.["balance"]).toBe(result.page[0]?.["balance"]);
    });
});

describe("mask — 'hash' routes through the shared FNV-1a digest", () => {
    it("returns the shared digest of the cell value, unaltered", async () => {
        expect.assertions(5);

        for (const value of HASH_INPUTS) {
            const database = createFakeDatabase([{ _id: "u1", secret: value, table: "users" }]);

            const handler = lunora.query
                .use(maskForTest({ users: { secret: "hash" } }))
                .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("users"));

            // eslint-disable-next-line no-await-in-loop -- one handler per input; sequential reads keep a failure pointed at the offending input
            const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

            expect(result.page[0]?.["secret"]).toBe(fnv1aHex(value));
        }
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

describe("mask — with-relation hops", () => {
    it("attaches a relationMask that masks each hop's TARGET table", async () => {
        expect.assertions(3);

        // The middleware sits above ctx.db and never sees `with`-hydrated rows —
        // the relation loader does. So it hands the loader a per-hop mask; without
        // it, `findMany("posts", { with: { author: true } })` returns a masked
        // `users.email` in the clear, and chained `with` reaches tables the caller
        // cannot name directly.
        const database = createFakeDatabase([{ _id: "p1", table: "posts", title: "Hello" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { email: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("posts", {}));

        await handler.handler(makeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "findMany");
        const { relationMask } = call?.args as { relationMask?: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] };

        expect(relationMask).toBeTypeOf("function");
        // A masked hop target is rewritten…
        expect(relationMask?.("users", [{ _id: "u1", email: "a@b.c", name: "Ada" }])).toEqual([{ _id: "u1", email: null, name: "Ada" }]);
        // …an unmasked one passes through untouched.
        expect(relationMask?.("posts", [{ _id: "p1", title: "Hello" }])).toEqual([{ _id: "p1", title: "Hello" }]);
    });
});

describe("mask — relation-depth value oracle fails closed (regression)", () => {
    const SSN = "123-45-6789";
    const AUTHOR = { _id: "u1", name: "Ada", ssn: SSN, table: "users" };
    const POST = { _id: "p1", authorId: "u1", table: "posts" };

    /**
     * A writer whose relation loader HONOURS the per-hop `where` and masks the
     * survivors — what `@lunora/shard-engine`'s `resolveWith` actually does.
     *
     * That behaviour is what makes these tests a real oracle rather than an
     * output-shape assertion: with the depth guard removed, a right guess comes
     * back with an `author` (whose `ssn` is dutifully `null`) and a wrong guess
     * comes back with none, so the caller reads the hidden value out of the
     * PRESENCE of the child row, in ~34 range-narrowing queries for a 9-digit
     * value. The root table (`posts`) carries no mask at all, which is why the
     * root-scoped guards never looked.
     */
    const oracleDatabase = (): FakeDatabase => {
        const database = createFakeDatabase([POST, AUTHOR]);

        database.writer.findMany = async (tableName, args) => {
            database.calls.push({ args, method: "findMany", tableOrId: tableName });

            const hop = (args as { with?: Record<string, { where?: Record<string, { eq?: unknown }> }> } | undefined)?.with?.["author"];
            const predicate = hop?.where;
            const matches =
                predicate === undefined ||
                Object.entries(predicate).every(([column, operators]) => (AUTHOR as Record<string, unknown>)[column] === operators.eq);
            const children = matches ? [AUTHOR as Record<string, unknown>] : [];
            const relationMask = (args as { relationMask?: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] } | undefined)
                ?.relationMask;
            const masked = relationMask ? relationMask("users", children) : children;

            return { continueCursor: null, isDone: true, page: [{ ...POST, author: masked[0] ?? null }] };
        };

        return database;
    };

    it("refuses a `with` hop that filters an UNMASKED root by a masked relation column", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("posts", { with: { author: { where: { ssn: { eq: SSN } } } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("refuses the same filter nested one level deeper in `with`", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db.findMany("posts", {
                with: { comments: { with: { author: { where: { ssn: { gte: "500-00-0000" } } } } } },
            }),
        );

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("refuses a relation PREDICATE in the root `where` that filters a masked column", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("posts", { where: { author: { is: { ssn: { eq: SSN } } } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("refuses a `with` hop that ORDERS by a masked relation column", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("posts", { with: { author: { orderBy: [{ ssn: "asc" }] } } }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("still serves a relation hop filtered by a NON-masked column", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findMany("posts", { with: { author: { where: { name: { eq: "Ada" } } } } }));

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        // The guard is scoped to masked columns, not a blanket ban on relation
        // filters — and the hydrated child is still masked on the way out.
        expect((result.page[0] as { author?: Record<string, unknown> }).author).toMatchObject({ name: "Ada", ssn: null });
    });

    /**
     * Glue a `posts` facade entry onto the fake writer, the way codegen's
     * `bindTableFacade` does — so the read can use the IDIOMATIC
     * `ctx.db.posts.findMany(...)` form instead of the flat method form every
     * test above uses. `isFacadeEntry` recognises an entry structurally, by
     * `findMany` + `withSearchIndex`, so those two are all the fixture needs.
     */
    const withPostsFacade = (database: FakeDatabase): void => {
        const facade = database.writer as FakeDatabase["writer"] & Record<string, unknown>;

        facade["posts"] = {
            findMany: async (args?: unknown) => database.writer.findMany("posts", args),
            withSearchIndex: () => {
                throw new Error("withSearchIndex not used in these tests");
            },
        };
    };

    it("refuses the hop filter through the per-table FACADE of an UNMASKED root", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        withPostsFacade(database);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, { findMany: (args?: unknown) => Promise<unknown> }> };

            return db["posts"]!.findMany({ with: { author: { where: { ssn: { eq: SSN } } } } });
        });

        await expect(handler.handler(makeContext(database, "u1") as unknown as Record<string, unknown>, {})).rejects.toMatchObject({
            code: "MASK_UNSUPPORTED",
            name: "LunoraError",
        });
    });

    it("masks a hop-hydrated child read through the per-table FACADE of an UNMASKED root", async () => {
        expect.assertions(1);

        const database = oracleDatabase();

        withPostsFacade(database);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, { findMany: (args?: unknown) => Promise<Page> }> };

            return db["posts"]!.findMany({ with: { author: true } });
        });

        const result = await handler.handler(makeContext(database, "u1"), {});

        // Without the facade rebind the read never reaches the wrapper, so no
        // `relationMask` is threaded and the child's masked column comes back in
        // the clear — a straight mask bypass, not merely an oracle.
        expect((result.page[0] as { author?: Record<string, unknown> }).author).toMatchObject({ ssn: null });
    });
});

describe("mask — stacked middlewares", () => {
    it("resolves a stacked policy in the SAME order for relation rows as for top-level rows", async () => {
        expect.assertions(2);

        // The chain is an onion: `.use(mask(A))` wraps ctx.db first, `.use(mask(B))`
        // wraps that, so a top-level row comes back through A then B. The ARGS
        // travel the other way (B attaches its hook, A sees it as `inner`), so a
        // naive composition applies B then A and a stacked policy resolves
        // differently on a parent than on its `with`-hydrated child.
        const database = createFakeDatabase([{ _id: "p1", table: "posts", title: "Hello" }]);

        const handler = lunora.query
            // A redacts; B would hash. A-then-B on a redacted (null) value keeps null.
            .use(maskForTest({ users: { email: "redact" } }))
            .use(maskForTest({ users: { email: () => "HASHED" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.findFirst("users", {}));

        // Capture the composed hook off the args the inner writer received.
        await handler.handler(makeContext(database, "u1"), {});

        const call = database.calls.find((entry) => entry.method === "findFirst");
        const { relationMask } = call?.args as { relationMask: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] };

        // A runs first (redact → null), then B maps that null to "HASHED".
        expect(relationMask("users", [{ email: "a@b.c" }])).toEqual([{ email: "HASHED" }]);
        // …and a table neither policy names is untouched by both.
        expect(relationMask("posts", [{ title: "Hello" }])).toEqual([{ title: "Hello" }]);
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

    it("does not surface rankPageRows() when mask() is composed OVER a guard-shaped writer that omits it (plan 254)", async () => {
        expect.assertions(1);

        // The realistic production shape: under `.rls("required")`, the `ctx.db`
        // that flows into `mask()` is ALREADY the output of `@lunora/shard-engine`'s
        // `guardWriter`, not a bare fake. This is the exact composition the
        // original bug broke — `guardWriter` used to install `rankPageRows`
        // unconditionally, so it was always present (and would TypeError on
        // call) even when the raw writer never had it.
        const database = createFakeDatabase([{ _id: "u1", ssn: "123-45-6789", table: "users" }]);
        const guarded = withRlsGuardShape(database.writer);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(({ ctx }) => typeof (ctx as unknown as TestContext).db.rankPageRows);

        await expect(handler.handler({ auth: { userId: "u1" }, db: guarded }, {})).resolves.toBe("undefined");
    });
});

describe("mask — bare-index-scan / rank declaration oracle fails closed (plan 250)", () => {
    it("bare withIndex(name) over an index whose DECLARED fields include a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const seed = [{ _id: "u1", createdAt: 1, ssn: "123-45-6789", table: "users" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { index: { by_ssn: ["ssn"] } } } }))
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
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { index: { by_createdAt: ["createdAt"] } } } }))
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
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { index: { by_ssn_time: ["createdAt", "ssn"] } } } }))
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
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { index: { by_ssn: ["ssn"] } } } }))
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
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { by_ssn_rank: ["ssn"] } } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "by_ssn_rank", { row: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rank() over a rank index whose declared `partitionBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { by_score_per_ssn: ["score", "ssn"] } } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "by_score_per_ssn", { row: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rank() over an all-unmasked rank index passes through", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { leaderboard: ["score"] } } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rank("users", "leaderboard", { row: "u1" }));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result).toStrictEqual({ position: 1, total: 1 });
        expect(database.calls.some((call) => call.method === "rank")).toBe(true);
    });

    it("rankPage() over a rank index whose declared `sortBy` names a masked column throws MASK_UNSUPPORTED", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { by_ssn_rank: ["ssn"] } } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankPage("users", "by_ssn_rank", {}));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
        expect(database.calls.some((call) => call.method === "rankPage")).toBe(false);
    });

    it("rankPage() over an all-unmasked rank index still works and masks output", async () => {
        expect.assertions(2);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { leaderboard: ["score"] } } } }))
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
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { by_ssn_rank: ["ssn"] } } } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.rankBefore?.("users", "by_ssn_rank", { rowId: "u1" }));

        await expect(handler.handler(makeContext(database, "u1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("rankBefore absent on the base writer (D1 twin) is not synthesized even when `indexFields` is supplied — no crash", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([{ _id: "u1", score: 10, ssn: "123-45-6789", table: "users" }]);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }, { indexFields: { users: { rank: { by_ssn_rank: ["ssn"] } } } }))
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
            .use(maskForTest({ users: { homeLocation: "redact" } }, { indexFields: { users: { geo: { by_location: ["homeLocation"] } } } }))
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
            .use(maskForTest({ users: { email: "redact" } }, { indexFields: { users: { geo: { by_location: ["homeLocation"] } } } }))
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

describe("mask — index name reused across kinds is looked up in its own namespace (plan 258)", () => {
    // `places` declares a REGULAR index and a GEO index sharing the name
    // "byLoc" — legal and unambiguous at the engine level (three separate
    // namespaces: `tableDefinition.indexes` / `.geoIndexes` / `.rankIndexes`),
    // but a flat `indexFieldsFromSchema` map used to let the later-built geo
    // entry overwrite the regular one, so the guard checked the WRONG index's
    // declared fields for a `withIndex("byLoc")` read.
    const placesSchema = defineSchema({
        places: defineTable({ coords: v.geoPoint(), homeAddress: v.string() }).index("byLoc", ["homeAddress"]).geoIndex("byLoc", { field: "coords" }),
    });

    it("bare withIndex(name) throws when the REGULAR index's own declared fields (not the colliding geo entry's) include a masked column", async () => {
        expect.assertions(1);

        const seed = [{ _id: "p1", coords: { lat: 1, lng: 2 }, homeAddress: "1 Main St", table: "places" }];
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ places: { homeAddress: "redact" } }, { indexFields: indexFieldsFromSchema(placesSchema) }))
            // Pre-fix (flat map): the geo entry `["coords"]` was written to the
            // map AFTER the regular entry and overwrote it, so the guard checked
            // `["coords"]` against the masked `homeAddress` column, found no
            // intersection, and let the bare scan through — reopening the
            // ordinal oracle plans 247/250 closed. Post-fix: the guard looks up
            // `places.index.byLoc` (not `places.geo.byLoc`) and correctly finds
            // `homeAddress` masked.
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("places").withIndex("byLoc").collect());

        await expect(handler.handler(makeContext(database, "p1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
    });

    it("mirror: withIndex(name) over the unmasked REGULAR index succeeds, while withGeoIndex over the same colliding name still throws for the masked geo field", async () => {
        expect.assertions(2);

        const seed = [{ _id: "p1", coords: { lat: 1, lng: 2 }, homeAddress: "1 Main St", table: "places" }];

        // `withIndex` succeeds: `homeAddress` (the regular index's declared
        // field) is not masked. Pre-fix (flat map), this used to THROW instead —
        // the false-denial mirror bug — because the colliding geo entry's
        // masked `coords` field shadowed the regular index's own (unmasked)
        // declared fields.
        const indexDatabase = createFakeDatabase(seed);

        enableQueryReader(indexDatabase, seed);

        const indexHandler = lunora.query
            .use(maskForTest({ places: { coords: "redact" } }, { indexFields: indexFieldsFromSchema(placesSchema) }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("places").withIndex("byLoc").collect());

        await expect(indexHandler.handler(makeContext(indexDatabase, "p1"), {})).resolves.toHaveLength(1);

        // `withGeoIndex` over the SAME name still throws: `coords` (the geo
        // index's own declared field) is masked.
        const geoDatabase = createFakeDatabase(seed);

        enableQueryReader(geoDatabase, seed);

        const geoHandler = lunora.query
            .use(maskForTest({ places: { coords: "redact" } }, { indexFields: indexFieldsFromSchema(placesSchema) }))
            .query(async ({ ctx }) =>
                (ctx as unknown as TestContext).db
                    .query("places")
                    .withGeoIndex("byLoc", (q) => q.near({ lat: 1, lng: 2 }, 1000))
                    .collect(),
            );

        await expect(geoHandler.handler(makeContext(geoDatabase, "p1"), {})).rejects.toMatchObject({ code: "MASK_UNSUPPORTED", name: "LunoraError" });
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

        return { auth: { userId }, db };
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

    /**
     * This test used to pin the opposite — "leaves a non-masked table's facade
     * entry on its original binding" — on the reasoning that an unmasked table
     * needs no masking. That was wrong: a read of an UNMASKED table reaches a
     * masked column through a relation (`events.findMany({ with: { user: … } })`
     * hydrates a masked `users` row, and a per-hop `where` on it is the value
     * oracle `assertWithAllowed` closes). Both the `relationMask` that redacts
     * the child and the hop guard live on the wrapped writer, so an unmasked
     * table left on its raw binding was a mask BYPASS via the idiomatic facade
     * form — see the two facade tests in the relation-depth describe above.
     */
    it("re-binds EVERY facade entry through the mask, masked table or not", async () => {
        expect.assertions(3);

        const database = createFakeDatabase([{ _id: "e1", table: "events", title: "Launch" }]);

        let usersEntry: unknown;
        let eventsEntry: unknown;

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => {
            const { db } = ctx as unknown as { db: Record<string, unknown> };

            usersEntry = db["users"];
            eventsEntry = db["events"];

            return (db["events"] as { findMany: (args?: unknown) => Promise<Page> }).findMany();
        });

        const context = makeFacadeContext(database, "u1");
        const originalEvents = (context["db"] as Record<string, unknown>)["events"];
        const originalUsers = (context["db"] as Record<string, unknown>)["users"];

        const result = await handler.handler(context, {});

        expect(eventsEntry).not.toBe(originalEvents);
        expect(usersEntry).not.toBe(originalUsers);
        // Re-bound, but nothing on `events` is masked — the policy still scopes
        // which VALUES are rewritten; only the routing changed.
        expect(result.page[0]).toEqual({ _id: "e1", table: "events", title: "Launch" });
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
            ["aggregate", "count", "findFirst", "findFirstOrThrow", "findMany", "groupBy", "rank", "rankBefore", "rankPage", "rankPageRows"].toSorted((a, b) =>
                a.localeCompare(b),
            ),
        );
    });
});

describe("mask — reader terminals mask before the caller sees a row", () => {
    /** Two rows on a masked table; `ssn` is the hidden value every probe below is aimed at. */
    const seedRows = () => [
        { _id: "u1", name: "Ann", ssn: "123-45-6789", table: "users" },
        { _id: "u2", name: "Bo", ssn: "987-65-4321", table: "users" },
    ];

    /**
     * SECURITY (value oracle): `.filter()`'s predicate must be handed the MASKED
     * row. If it sees the raw row, `.filter(d => d.ssn === guess)` is a one-guess-
     * per-call read of the hidden value: a correct guess returns rows, a wrong one
     * returns none, and the caller reads the secret off that difference.
     *
     * The probe is the assertion: a RIGHT guess and a WRONG guess must be
     * indistinguishable to the caller — same row count, same payload.
     */
    const probeWithGuess = async (guess: string): Promise<Record<string, unknown>[]> => {
        const seed = seedRows();
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .filter((document) => document["ssn"] === guess)
                .collect(),
        );

        return handler.handler(makeContext(database, "u1"), {});
    };

    it("filter() is not a value oracle — a right guess and a wrong guess are indistinguishable", async () => {
        expect.assertions(3);

        const rightGuess = await probeWithGuess("123-45-6789");
        const wrongGuess = await probeWithGuess("000-00-0000");

        // Both must miss: the predicate compares against the redacted `null`.
        expect(rightGuess).toHaveLength(0);
        expect(wrongGuess).toHaveLength(0);
        expect(rightGuess).toStrictEqual(wrongGuess);
    });

    it("filter() still matches on a NON-masked column, and masks what it hands back", async () => {
        expect.assertions(3);

        const seed = seedRows();
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query.use(maskForTest({ users: { ssn: "redact" } })).query(async ({ ctx }) =>
            (ctx as unknown as TestContext).db
                .query("users")
                .filter((document) => document["name"] === "Ann")
                .collect(),
        );

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(1);
        expect(rows[0]?.["name"]).toBe("Ann");
        expect(rows[0]?.["ssn"]).toBeNull();
    });

    it("first() masks the row it returns (bare query, no index chain)", async () => {
        expect.assertions(2);

        const seed = seedRows();
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").first());

        const row = await handler.handler(makeContext(database, "u1"), {});

        expect(row?.["ssn"]).toBeNull();
        expect(row?.["name"]).toBe("Ann");
    });

    it("first() returns the null sentinel for an empty table rather than throwing", async () => {
        expect.assertions(1);

        const database = createFakeDatabase([]);

        enableQueryReader(database, []);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").first());

        await expect(handler.handler(makeContext(database, "u1"), {})).resolves.toBeNull();
    });

    it("paginate() masks every row on the page", async () => {
        expect.assertions(3);

        const seed = seedRows();
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").paginate());

        const result = (await handler.handler(makeContext(database, "u1"), {})) as Page;

        expect(result.page).toHaveLength(2);
        expect(result.page[0]?.["ssn"]).toBeNull();
        expect(result.page[1]?.["ssn"]).toBeNull();
    });

    it("take() masks every row it returns", async () => {
        expect.assertions(3);

        const seed = seedRows();
        const database = createFakeDatabase(seed);

        enableQueryReader(database, seed);

        const handler = lunora.query
            .use(maskForTest({ users: { ssn: "redact" } }))
            .query(async ({ ctx }) => (ctx as unknown as TestContext).db.query("users").take(2));

        const rows = await handler.handler(makeContext(database, "u1"), {});

        expect(rows).toHaveLength(2);
        expect(rows[0]?.["ssn"]).toBeNull();
        expect(rows[1]?.["ssn"]).toBeNull();
    });
});
