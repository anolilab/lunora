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

interface FakeReader {
    collect: () => Promise<Record<string, unknown>[]>;
    filter: (predicate: (document: Record<string, unknown>) => boolean) => FakeReader;
    first: () => Promise<Record<string, unknown> | null>;
    order: (direction: "asc" | "desc") => FakeReader;
    paginate: () => Promise<{ continueCursor: null | string; isDone: boolean; page: Record<string, unknown>[] }>;
    take: (limit: number) => Promise<Record<string, unknown>[]>;
    unique: () => Promise<Record<string, unknown> | null>;
    withIndex: (indexName?: string) => FakeReader;
    withSearchIndex: () => FakeReader;
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
        query: (tableName: string) => FakeReader;
        rank: (tableName: string, indexName: string, options: unknown) => Promise<null | { position: number; total: number }>;
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

/** Enable the optional `getWithTable` fast-path seam (mirrors `@lunora/do`'s `lookupById`). */
const enableGetWithTable = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    const byId = new Map(rows.map((row) => [row._id, row] as const));

    // eslint-disable-next-line no-param-reassign -- the helper installs the seam on the caller's fake writer
    database.writer.getWithTable = async (id) => {
        database.calls.push({ args: undefined, method: "getWithTable", tableOrId: id });
        const row = byId.get(id);

        return row ? { row, tableName: row.table } : null;
    };
};

/**
 * Install a chainable `query()` reader on the fake writer — the legacy
 * iterator-style reader that masking's `wrapReader` wraps. Mirrors `@lunora/do`'s
 * reader surface (`withIndex` / `order` / `filter` / terminal `collect` etc.) so
 * the full chain, including `.order()`, is exercised end-to-end.
 */
const enableQueryReader = (database: FakeDatabase, rows: (Record<string, unknown> & { _id: string; table: string })[]): void => {
    const makeReader = (list: Record<string, unknown>[]): FakeReader => {
        return {
            collect: async () => list,
            filter: (predicate) => makeReader(list.filter((row) => predicate(row))),
            first: async () => list[0] ?? null,
            order: (direction) => makeReader(direction === "desc" ? list.toReversed() : list),
            paginate: async () => {
                return { continueCursor: null, isDone: true, page: list };
            },
            take: async (limit) => list.slice(0, limit),
            unique: async () => list[0] ?? null,
            withIndex: () => makeReader(list),
            withSearchIndex: () => makeReader(list),
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

    it("mASK_UNSUPPORTED carries HTTP status 422", () => {
        expect.assertions(1);

        expect(new LunoraError("MASK_UNSUPPORTED").status).toBe(422);
    });
});

describe("mask — get() table resolution", () => {
    it("masks via the getWithTable fast path", async () => {
        expect.assertions(2);

        const rows = [{ _id: "u1", email: "a@x.com", table: "users" }];
        const database = createFakeDatabase(rows);

        enableGetWithTable(database, rows);

        const handler = lunora.query.use(maskForTest({ users: { email: "redact" } })).query(async ({ ctx }) => (ctx as unknown as TestContext).db.get("u1"));

        const result = await handler.handler(makeContext(database, "u1"), {});

        expect(result?.["email"]).toBeNull();
        expect(database.calls.some((call) => call.method === "getWithTable")).toBe(true);
    });

    it("masks via the probe fallback when getWithTable is absent", async () => {
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
