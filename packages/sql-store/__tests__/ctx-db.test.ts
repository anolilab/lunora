import { DatabaseSync } from "node:sqlite";

import { MAX_SEARCH_SCAN } from "@lunora/search-core";
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { CURSOR_PREFIX } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlDialect } from "../src/dialect";
import { sqliteDecode, sqliteEncode } from "../src/value-codec";

/**
 * In-package end-to-end coverage for the dialect-blind store core. The concrete
 * SqlDialect implementations live in `@lunora/d1` / `@lunora/hyperdrive`, so this
 * suite stands up a minimal SQLite dialect over Node's built-in `node:sqlite`
 * engine (D1 is SQLite — the generated SQL behaves identically) plus a tiny
 * recording exec for the cross-dialect rendering checks. No workerd required.
 */

/** Both workerd and `node:sqlite` phrase a UNIQUE-index breach as "UNIQUE constraint failed". */
const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

const sqlAffinityForKind = (kind: string | undefined): string => {
    switch (kind) {
        case "bigint": {
            return "TEXT";
        }
        case "boolean": {
            return "INTEGER";
        }
        case "number": {
            return "REAL";
        }
        default: {
            return "TEXT";
        }
    }
};

/** A minimal reference SQLite dialect, mirroring `@lunora/d1`'s sqliteDialect (kept local so sql-store has no dependency on a downstream package). */

/**
 * Does this runtime's `node:sqlite` have the FTS5 module compiled in?
 *
 * It is a property of the RUNTIME, not of the dialect: Node 24 bundles a SQLite
 * with FTS5, Node 22 does not. Hard-coding `supportsFts5: true` made these
 * tests pass on one CI matrix leg and fail on the other with
 * `no such module: fts5`.
 *
 * Probing keeps both legs meaningful rather than skipping: where FTS5 exists
 * the suite exercises the `fts5` search layout, and where it does not it
 * exercises the portable `inverted` layout — which is exactly the split the
 * store already models for backends without FTS5.
 */
const RUNTIME_HAS_FTS5 = ((): boolean => {
    const probe = new DatabaseSync(":memory:");

    try {
        probe.exec("CREATE VIRTUAL TABLE __fts5_probe USING fts5(x)");

        return true;
    } catch {
        return false;
    } finally {
        probe.close();
    }
})();

const makeSqliteDialect = (name: SqlDialect["name"] = "sqlite"): SqlDialect => {
    return {
        columnType: (kind) => sqlAffinityForKind(kind),
        companionTypes: {
            autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
            integer: "INTEGER",
            key: "TEXT",
            real: "REAL",
            text: "TEXT",
        },
        decode: (value, kind) => sqliteDecode(value, kind),
        encode: (value) => sqliteEncode(value),
        maxTableColumns: 100,
        frameworkColumns: () => [
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ],
        isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
        name,
        supportsFts5: RUNTIME_HAS_FTS5,
        supportsReturning: true,
        tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
    };
};

const createSqliteHarness = (): { close: () => void; exec: SqlCtxExec } => {
    const database = new DatabaseSync(":memory:");

    const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

    return {
        close: () => {
            database.close();
        },
        exec: {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        },
    };
};

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

/** An `optional(inner)` column — stays nullable in the DDL; `effectiveColumnKind` unwraps to `inner` for storage affinity/decode. */
const optionalCol = (innerKind: string): ValidatorLike =>
    ({ _meta: { column: { notNull: false }, inner: { _meta: { column: { notNull: false } }, kind: innerKind } }, kind: "optional" }) as never;

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                priority: col("number"),
                slug: col("string", { unique: true }),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

/**
 * A field added to a `.global()` table after its first deployment.
 *
 * This is the regression that motivated the reconciliation: `CREATE TABLE IF NOT
 * EXISTS` is a no-op against an existing table, so the new column was created on
 * fresh databases and silently absent on every deployed one. Reads degraded
 * quietly (the field just read as absent) but WRITES failed outright, because the
 * writer builds its column list from the schema shape — and nothing anywhere
 * failed on a fresh database, so CI and every local dev loop stayed green.
 */
describe("createSqlCtxDb — adding a field to an already-provisioned global table", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    /** `schema` plus one new optional column, as a later release would declare it. */
    const widened: SchemaLike = {
        tables: {
            notes: {
                indexes: [],
                shape: { ...schema.tables["notes"]?.shape, pinnedAt: optionalCol("number") },
                shardMode: { kind: "global" },
            },
        },
    } as never;

    it("adds the column to the existing table, so a write that names it succeeds", async () => {
        expect.assertions(2);

        const before = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema });

        await before.insert("notes", { archived: false, body: "first", priority: 1, slug: "a" });

        // A later release declares one more field against the SAME database.
        const after = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema: widened });
        const id = await after.insert("notes", { archived: false, body: "second", pinnedAt: 1234, priority: 2, slug: "b" });

        await expect(after.get(id)).resolves.toMatchObject({ pinnedAt: 1234, slug: "b" });

        // The row written before the column existed still reads — and reads the new
        // field back as `null`, not `undefined`, because ALTER backfills NULL and
        // that is what the decoder sees. Worth pinning: a consumer testing
        // `=== undefined` on a column added this way silently takes the wrong branch.
        const rows = await after.findMany("notes", { where: { slug: "a" } });

        expect((rows.page[0] as Record<string, unknown>)["pinnedAt"]).toBeNull();
    });

    it("patches an existing row through the new column", async () => {
        expect.assertions(1);

        const before = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema });
        const id = await before.insert("notes", { archived: false, body: "first", priority: 1, slug: "a" });

        const after = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema: widened });

        await after.patch(id, { pinnedAt: 99 });

        await expect(after.get(id)).resolves.toMatchObject({ pinnedAt: 99 });
    });

    it("refuses a new REQUIRED field rather than letting the write fail with `no such column`", async () => {
        expect.assertions(1);

        const before = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema });

        await before.insert("notes", { archived: false, body: "first", priority: 1, slug: "a" });

        // SQLite cannot ADD COLUMN … NOT NULL without a default, and inventing one
        // would write a value of the store's choosing into every existing row.
        const required: SchemaLike = {
            tables: {
                notes: { indexes: [], shape: { ...schema.tables["notes"]?.shape, owner: col("string") }, shardMode: { kind: "global" } },
            },
        } as never;
        const after = createSqlCtxDb({ dialect: makeSqliteDialect(), exec: harness.exec, schema: required });

        await expect(after.insert("notes", { archived: false, body: "x", owner: "u1", priority: 1, slug: "c" })).rejects.toThrow(
            'declares a new required field "owner"',
        );
    });
});

describe("createSqlCtxDb — auto-provision + crud over node:sqlite", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeWriter = () => createSqlCtxDb({ clock: () => 1_700_000_000_000, dialect: makeSqliteDialect(), exec: harness.exec, schema });

    it("auto-provisions the table and round-trips an inserted document", async () => {
        expect.assertions(3);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "hello", priority: 3, slug: "a" });

        expect(typeof id).toBe("string");

        const doc = await writer.get(id);

        expect(doc).toMatchObject({ archived: false, body: "hello", priority: 3, slug: "a" });
        expect(doc?._id).toBe(id);
    });

    it("decodes booleans and numbers back to their JS forms", async () => {
        expect.assertions(2);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: true, body: "x", priority: 7, slug: "b" });
        const doc = await writer.get(id);

        expect(doc?.archived).toBe(true);
        expect(doc?.priority).toBe(7);
    });

    it("patch updates only the provided fields", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "c" });

        await writer.patch(id, { body: "patched" });

        const doc = await writer.get(id);

        expect(doc).toMatchObject({ archived: false, body: "patched", priority: 1, slug: "c" });
    });

    it("delete removes the row", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "d" });

        await writer.delete(id);

        await expect(writer.get(id)).resolves.toBeNull();
    });

    it("maps a UNIQUE-constraint breach to a ConflictError", async () => {
        expect.assertions(1);

        const writer = makeWriter();

        await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "dup" });

        await expect(writer.insert("notes", { archived: false, body: "y", priority: 2, slug: "dup" })).rejects.toThrow(/unique constraint/iu);
    });

    it("findMany filters, orders, and paginates with a cursor", async () => {
        expect.assertions(3);

        const writer = makeWriter();

        for (const [index, slug] of ["s1", "s2", "s3"].entries()) {
            // eslint-disable-next-line no-await-in-loop -- sequential seeding for a deterministic order
            await writer.insert("notes", { archived: false, body: slug, priority: index, slug });
        }

        const first = await writer.findMany("notes", { limit: 2, orderBy: [{ priority: "asc" }] });

        expect(first.page.map((row) => row.slug)).toStrictEqual(["s1", "s2"]);
        expect(first.isDone).toBe(false);

        const second = await writer.findMany("notes", { cursor: first.continueCursor ?? undefined, limit: 2, orderBy: [{ priority: "asc" }] });

        expect(second.page.map((row) => row.slug)).toStrictEqual(["s3"]);
    });

    it("count() returns the matching row total", async () => {
        expect.assertions(2);

        const writer = makeWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "n1" });
        await writer.insert("notes", { archived: true, body: "b", priority: 2, slug: "n2" });

        await expect(writer.count("notes")).resolves.toBe(2);
        await expect(writer.count("notes", { where: { archived: true } })).resolves.toBe(1);
    });

    it("a foreign id can never read another table's row by id (IDOR guard)", async () => {
        expect.assertions(1);

        const writer = makeWriter();
        const id = await writer.insert("notes", { archived: false, body: "x", priority: 1, slug: "idor" });

        // Pin a different (non-existent) table — a branded id must resolve to its own table only.
        await expect(writer.get(id, "other")).resolves.toBeNull();
    });
});

/** A `notes` schema carrying a two-column rank index so the seek/before predicates emit prefix equalities. */
describe("createSqlCtxDb — the column ceiling", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    // D1 runs Workerd's SQLite build, which sets SQLITE_LIMIT_COLUMN to 100.
    // Provisioning a wider table used to fail with a bare "too many columns"
    // that named neither the table nor the ceiling.
    it("refuses to provision a global table wider than 100 columns", async () => {
        expect.assertions(1);

        const wide: SchemaLike = {
            tables: {
                wide: {
                    indexes: [],
                    shape: Object.fromEntries(Array.from({ length: 99 }, (_unused, index) => [`f${String(index)}`, col("string")])),
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: wide });

        await expect(writer.insert("wide", { f0: "x" })).rejects.toThrow(/over this engine's 100-column limit/u);
    });

    it("provisions a table that exactly fills the budget", async () => {
        expect.assertions(1);

        // 98 declared fields + the id/_creationTime framework columns = 100.
        const atLimit: SchemaLike = {
            tables: {
                atLimit: {
                    indexes: [],
                    shape: Object.fromEntries(Array.from({ length: 98 }, (_unused, index) => [`f${String(index)}`, col("string")])),
                    shardMode: { kind: "global" },
                },
            },
        } as never;

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: atLimit });
        const row = Object.fromEntries(Array.from({ length: 98 }, (_unused, index) => [`f${String(index)}`, "x"]));

        expect(typeof (await writer.insert("atLimit", row))).toBe("string");
    });
});

const rankSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            rankIndexes: [
                {
                    name: "byPriority",
                    on: "notes",
                    partitionBy: ["archived"],
                    sortBy: [
                        { direction: "desc", field: "priority" },
                        { direction: "asc", field: "slug" },
                    ],
                },
            ],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                priority: col("number"),
                slug: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

/** `notes` again, with a search index so `.withSearchIndex()` is reachable. */
const searchSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            searchIndexes: [{ field: "body", name: "by_body" }],
            shape: { body: col("string") },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — search iteration terminates like collect()", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeSearchWriter = () => createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: searchSchema });

    const seedMatching = async (writer: ReturnType<typeof makeSearchWriter>, count: number): Promise<void> => {
        for (let index = 0; index < count; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- sequential inserts keep the search companion in step with the row writes
            await writer.insert("notes", { body: `alpha note ${String(index)}` });
        }
    };

    it("yields every match when the result set is under the cap", async () => {
        expect.assertions(1);

        const writer = makeSearchWriter();

        await seedMatching(writer, 5);

        const seen: unknown[] = [];

        for await (const row of writer.query("notes").withSearchIndex("by_body", (q) => q.search("body", "alpha"))) {
            seen.push(row);
        }

        expect(seen).toHaveLength(5);
    });

    it("raises the cap error rather than stopping silently at the cap", async () => {
        expect.assertions(2);

        // A search page is capped at MAX_SEARCH_SCAN, and a page sized to
        // the cap cannot fetch the probe row that tells "exactly that many
        // matches" from "ten times as many" — so `planSearchPage` refuses it
        // rather than reporting a false `isDone`. Iterating must therefore
        // raise the same cap error `.collect()` raises: same query, same data,
        // one answer.
        const writer = makeSearchWriter();

        await seedMatching(writer, MAX_SEARCH_SCAN + 1);

        const iterate = async (): Promise<void> => {
            for await (const row of writer.query("notes").withSearchIndex("by_body", (q) => q.search("body", "alpha"))) {
                expect(row).toBeUndefined(); // unreachable — the read refuses before yielding
            }
        };

        await expect(iterate()).rejects.toThrow(/documents match this search/u);
        await expect(
            writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collect(),
        ).rejects.toThrow(/documents match this search/u);
    });

    // `.collectWithScores()` (plan 236) surfaces the relevance score the
    // sharded DO backend already computes. The three `.global()` search
    // layouts compute + order by the same `__score__` in SQL but none of them
    // selects it back out — plumbing it through all three is follow-up work,
    // not this reader alone — so this fails closed with a clear message
    // rather than a bare "not a function", mirroring `withGeoIndex()`'s
    // existing `.global()`-unsupported guard.
    it("collectWithScores() fails closed on a .global() table with a clear message", async () => {
        expect.assertions(1);

        const writer = makeSearchWriter();

        await seedMatching(writer, 1);

        await expect(
            writer
                .query("notes")
                .withSearchIndex("by_body", (q) => q.search("body", "alpha"))
                .collectWithScores(),
        ).rejects.toThrow(/collectWithScores\(\) is not supported on `\.global\(\)` tables/u);
    });
});

describe("createSqlCtxDb — rank over node:sqlite", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("rank() reports a 1-based position within the partition", async () => {
        expect.assertions(3);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: rankSchema });

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });
        await writer.insert("notes", { archived: false, body: "c", priority: 10, slug: "c" });

        const top = await writer.findFirst("notes", { where: { slug: "a" } });
        const mid = await writer.findFirst("notes", { where: { slug: "b" } });

        await expect(writer.rank("notes", "byPriority", { row: String(top?._id) })).resolves.toEqual({ position: 1, total: 3 });
        await expect(writer.rank("notes", "byPriority", { row: String(mid?._id) })).resolves.toEqual({ position: 2, total: 3 });
        await expect(writer.rank("notes", "byPriority", { row: "missing" })).resolves.toBeNull();
    });

    it("rankPage paginates in rank order across a cursor", async () => {
        expect.assertions(2);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: rankSchema });

        for (const [index, slug] of ["a", "b", "c"].entries()) {
            // eslint-disable-next-line no-await-in-loop -- deterministic seeding
            await writer.insert("notes", { archived: false, body: slug, priority: 30 - index * 10, slug });
        }

        const first = await writer.rankPage("notes", "byPriority", { take: 2 });

        expect(first.page.map((row) => row.slug)).toStrictEqual(["a", "b"]);

        const second = await writer.rankPage("notes", "byPriority", { cursor: first.continueCursor ?? undefined, take: 2 });

        expect(second.page.map((row) => row.slug)).toStrictEqual(["c"]);
    });
});

/** A soft-delete (`deletedAt` marker) `notes` table carrying a rank index, exercising the delete/restore/patch → rank companion seam. */
const softRankSchema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            rankIndexes: [
                {
                    name: "byPriority",
                    on: "notes",
                    partitionBy: ["archived"],
                    sortBy: [{ direction: "desc", field: "priority" }],
                },
            ],
            shape: {
                archived: col("boolean"),
                body: col("string"),
                deletedAt: optionalCol("number"),
                priority: col("number"),
                slug: col("string"),
            },
            softDeleteMode: { field: "deletedAt" },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — soft-delete + rank companion", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    const makeSoftRankWriter = () => createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: softRankSchema });

    it("restore() re-adds the rank entry exactly once (regression: no duplicate-PK on soft-delete tables)", async () => {
        expect.assertions(3);

        const writer = makeSoftRankWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });

        const target = await writer.findFirst("notes", { where: { slug: "a" } });

        // Soft delete drops the row's rank companion entry.
        await writer.delete(String(target?._id));

        const afterDelete = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(afterDelete.page.map((row) => row.slug)).toStrictEqual(["b"]);

        // Previously restore()'s forced re-add double-inserted the companion row
        // and threw a raw UNIQUE-constraint (PRIMARY KEY `__id__`) violation.
        await expect(writer.restore?.(String(target?._id))).resolves.toBeUndefined();

        const afterRestore = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(afterRestore.page.map((row) => row.slug)).toStrictEqual(["a", "b"]);
    });

    it("patching a rank field of a soft-deleted row does not resurrect it in rank (regression)", async () => {
        expect.assertions(1);

        const writer = makeSoftRankWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 30, slug: "a" });
        await writer.insert("notes", { archived: false, body: "b", priority: 20, slug: "b" });

        const target = await writer.findFirst("notes", { where: { slug: "a" } });

        await writer.delete(String(target?._id));

        // An admin/cascade patch touches a RANK field (priority) of the still
        // soft-deleted row — it must NOT re-add the row to the rank companion.
        await writer.patch(String(target?._id), { priority: 99 });

        const page = await writer.rankPage("notes", "byPriority", { take: 10 });

        expect(page.page.map((row) => row.slug)).toStrictEqual(["b"]);
    });
});

/** A `.global()` table with a two-key aggregate index, so a groupBy `where` can pin a strict subset of the `by`-tuple. */
const groupSchema: SchemaLike = {
    tables: {
        events: {
            aggregateIndexes: [{ by: ["tenant", "status"], name: "byTenantStatus", on: "events", op: "count" }],
            indexes: [],
            shape: {
                status: col("string"),
                tenant: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — indexed groupBy honours a partial where", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    it("returns only the groups the where selects when it pins a subset of the by-tuple (regression: no leaked groups)", async () => {
        expect.assertions(3);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema: groupSchema });

        await writer.insert("events", { status: "active", tenant: "a" });
        await writer.insert("events", { status: "done", tenant: "a" });
        await writer.insert("events", { status: "active", tenant: "b" });

        // by=[tenant,status] with where pinning only `tenant` — the materialized
        // companion must not leak tenant "b" groups (indexed/scan divergence).
        const groups = await writer.groupBy("events", { agg: { op: "count" }, by: ["tenant", "status"], where: { tenant: "a" } });

        expect(groups).toHaveLength(2);
        expect(groups.every((entry) => (entry.key as { tenant: string }).tenant === "a")).toBe(true);
        expect(groups.some((entry) => (entry.key as { tenant: string }).tenant === "b")).toBe(false);
    });
});

/** A `notes` table carrying both an aggregate and a rank index, so one backfill pass exercises both companion-tally loops. */
const backfillSchema: SchemaLike = {
    tables: {
        notes: {
            aggregateIndexes: [{ by: ["archived"], name: "byArchived", on: "notes", op: "count" }],
            indexes: [],
            rankIndexes: [{ name: "byPriority", on: "notes", partitionBy: ["archived"], sortBy: [{ direction: "desc", field: "priority" }] }],
            shape: {
                archived: col("boolean"),
                priority: col("number"),
                slug: col("string"),
            },
            shardMode: { kind: "global" },
        },
    },
} as never;

describe("createSqlCtxDb — aggregate + rank backfills route through batch when the exec supports it", () => {
    it("issues one batch call per companion backfill (not one run() per row) when rebuilding from pre-existing rows", async () => {
        expect.assertions(3);

        const database = new DatabaseSync(":memory:");
        const all = (query: string, parameters: ReadonlyArray<unknown>): Record<string, unknown>[] => database.prepare(query).all(...(parameters as never[]));

        const plainExec: SqlCtxExec = {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        };

        let batchCalls = 0;
        const batchingExec: SqlCtxExec = {
            all: (query, parameters) => Promise.resolve(all(query, parameters)),
            batch: (statements) => {
                batchCalls += 1;

                for (const statement of statements) {
                    all(statement.sql, statement.params);
                }

                return Promise.resolve();
            },
            run: (query, parameters) => {
                all(query, parameters);

                return Promise.resolve();
            },
        };

        try {
            // Seed the base table (and migrate the companions) through a plain
            // writer, five rows, so a from-scratch backfill has more than one
            // tally/tuple to insert.
            const seeder = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: plainExec, schema: backfillSchema });

            for (const [index, slug] of ["a", "b", "c", "d", "e"].entries()) {
                // eslint-disable-next-line no-await-in-loop -- deterministic seeding
                await seeder.insert("notes", { archived: false, priority: index, slug });
            }

            // A SECOND writer over the SAME database, with its own empty
            // backfill cache: its first write re-derives both companions from
            // scratch — the historical backfill path both loops share — this
            // time through the batching exec.
            const rebuilder = createSqlCtxDb({ clock: () => 2, dialect: makeSqliteDialect(), exec: batchingExec, schema: backfillSchema });

            await rebuilder.insert("notes", { archived: false, priority: 99, slug: "f" });

            // One batch call for the aggregate tally backfill, one for the rank
            // tuple backfill — never a run()-per-row loop.
            expect(batchCalls).toBe(2);

            const groups = await rebuilder.groupBy("notes", { agg: { op: "count" }, by: ["archived"] });

            expect(groups[0]?.value).toBe(6);

            const page = await rebuilder.rankPage("notes", "byPriority", { take: 10 });

            expect(page.page).toHaveLength(6);
        } finally {
            database.close();
        }
    });
});

describe("createSqlCtxDb — cross-dialect SQL rendering", () => {
    /** A recording exec that captures every rendered statement and answers reads from a fixed row set. */
    const recordingExec = (rows: Record<string, unknown>[]): { exec: SqlCtxExec; statements: string[] } => {
        const statements: string[] = [];

        return {
            exec: {
                all: (query) => {
                    statements.push(query);

                    return Promise.resolve(rows);
                },
                run: (query) => {
                    statements.push(query);

                    return Promise.resolve();
                },
            },
            statements,
        };
    };

    // The NULL-safe-equality operator each engine must emit (never a bare `col IS ?`, which is SQLite-only).
    const NULL_SAFE_OPERATOR = { mysql: /<=>/u, postgres: /IS NOT DISTINCT FROM/u } as const;

    it.each(["postgres", "mysql"] as const)("renders the %s OCC guard with engine-correct NULL-safe equality", async (engine) => {
        expect.assertions(2);

        // A patch snapshots the row then issues a guarded UPDATE whose WHERE uses
        // NULL-safe equality on every column. On Postgres that must be
        // `IS NOT DISTINCT FROM`, on MySQL `<=>`.
        const snapshotRow = { _creationTime: 1, archived: 0, body: "x", id: "row1", priority: 1, slug: "s" };
        // get/patch both read; return the row for every SELECT, plus an `id` for the RETURNING CAS.
        const { exec, statements } = recordingExec([snapshotRow]);
        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema });

        await writer.patch("row1", { body: "y" });

        const guarded = statements.find((statement) => /update .*notes.* set/iu.test(statement));

        expect(guarded).toBeDefined();
        expect(guarded).toMatch(NULL_SAFE_OPERATOR[engine]);
    });

    it.each(["postgres", "mysql"] as const)(
        "renders the %s rankPage cursor seek with engine-correct prefix equality (regression: bare `IS` is SQLite-only)",
        async (engine) => {
            expect.assertions(2);

            // A cursor-seeked rankPage emits an OR-of-AND seek whose prefix columns
            // are fixed by NULL-safe equality. Those prefix equalities must render
            // as `IS NOT DISTINCT FROM` (Postgres) / `<=>` (MySQL).
            // rankTableExists → non-empty so the companion counts as "exists";
            // the backfill source scan then reads from the same set (harmless).
            const { exec, statements } = recordingExec([{ __id__: "x", __partition__: "0", sort_0: 30, sort_1: "a" }]);
            const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(engine), exec, schema: rankSchema });

            // A 4-element cursor matches [partition, sort_0, sort_1, __id__].
            // Minted the way the engine mints them: `decodeCursor` refuses a
            // cursor without the format marker.
            const cursor = CURSOR_PREFIX + btoa(JSON.stringify(["0", 30, "a", "x"]));

            await writer.rankPage("notes", "byPriority", { cursor, take: 2 });

            const seek = statements.find((statement) => /from .*__rank_bypriority.* where/iu.test(statement));

            expect(seek).toBeDefined();
            expect(seek).toMatch(NULL_SAFE_OPERATOR[engine]);
        },
    );
});

describe("createSqlCtxDb — _creationTime is server-authoritative", () => {
    /** A recording exec that captures every rendered statement WITH its bound params, answering reads from a fixed row set. */
    const recordingExecWithParams = (rows: Record<string, unknown>[]): { calls: { params: ReadonlyArray<unknown>; sql: string }[]; exec: SqlCtxExec } => {
        const calls: { params: ReadonlyArray<unknown>; sql: string }[] = [];

        return {
            calls,
            exec: {
                all: (query, parameters) => {
                    calls.push({ params: parameters, sql: query });

                    return Promise.resolve(rows);
                },
                run: (query, parameters) => {
                    calls.push({ params: parameters, sql: query });

                    return Promise.resolve();
                },
            },
        };
    };

    // A fixed clock so a minted `_creationTime` is a distinctive, assertable value.
    const CLOCK = 999;

    it("insert() WITHOUT allowExplicitId mints clock() and ignores a forged document _creationTime", async () => {
        expect.assertions(3);

        const { calls, exec } = recordingExecWithParams([]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        // A raw-forwarded client payload smuggling a backdated `_creationTime`.
        await writer.insert("notes", { _creationTime: 1, archived: false, body: "x", priority: 3, slug: "forge" });

        const insert = calls.find((call) => /insert into .*notes.* values/iu.test(call.sql));

        expect(insert).toBeDefined();
        // Values tuple is [id, _creationTime, ...fields], so the minted clock() lands at index 1 — never the forged 1.
        expect(insert?.params[1]).toBe(CLOCK);
        expect(insert?.params).not.toContain(1);
    });

    it("insert() WITH allowExplicitId honors the document _creationTime (import/CDC preservation)", async () => {
        expect.assertions(2);

        const { calls, exec } = recordingExecWithParams([]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        // The trusted import/CDC path opts in to preserve the original creation time.
        await writer.insert("notes", { _creationTime: 1, archived: false, body: "x", priority: 3, slug: "import" }, { allowExplicitId: true });

        const insert = calls.find((call) => /insert into .*notes.* values/iu.test(call.sql));

        expect(insert).toBeDefined();
        expect(insert?.params[1]).toBe(1);
    });

    it("replace() mints clock() and ignores a forged document _creationTime", async () => {
        expect.assertions(3);

        // resolveTableName + the OCC snapshot both read; return this row for every SELECT.
        const snapshotRow = { _creationTime: 42, archived: 0, body: "x", id: "row1", priority: 1, slug: "s" };
        const { calls, exec } = recordingExecWithParams([snapshotRow]);
        const writer = createSqlCtxDb({ clock: () => CLOCK, dialect: makeSqliteDialect(), exec, schema });

        await writer.replace("row1", { _creationTime: 5, archived: false, body: "y", priority: 7, slug: "s" });

        const update = calls.find((call) => /update .*notes.* set/iu.test(call.sql));

        expect(update).toBeDefined();
        // The SET clause binds `_creationTime = ?` first, so the minted clock() is the leading param — never the forged 5.
        expect(update?.params[0]).toBe(CLOCK);
        expect(update?.params).not.toContain(5);
    });
});

describe("createSqlCtxDb — the `.global()` changelog", () => {
    let harness: ReturnType<typeof createSqliteHarness>;

    beforeEach(() => {
        harness = createSqliteHarness();
    });

    afterEach(() => {
        harness.close();
    });

    /** A CDC-enabled writer over the real SQLite harness. */
    const makeCdcWriter = () => createSqlCtxDb({ cdc: true, clock: () => 1_700_000_000_000, dialect: makeSqliteDialect(), exec: harness.exec, schema });

    it("reports the tables written after a cursor, and the log head", async () => {
        expect.assertions(3);

        const writer = makeCdcWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "a" });

        const first = await writer.cdcChangedTables?.(0);

        expect(first).toMatchObject({ tables: ["notes"] });
        expect(first?.cursor).toBeGreaterThan(0);

        // Nothing has been written since that head, so the poll it drives has
        // nothing to re-read — which is the steady state the fast path exists for.
        const quiet = await writer.cdcChangedTables?.(first?.cursor ?? 0);

        expect(quiet).toMatchObject({ tables: [] });
    });

    it("bounds the table scan by the head it returns, so a concurrent write is not lost", async () => {
        expect.assertions(2);

        const writer = makeCdcWriter();

        await writer.insert("notes", { archived: false, body: "a", priority: 1, slug: "a" });

        const opened = await writer.cdcChangedTables?.(0);
        const head = opened?.cursor ?? 0;

        // A write landing after the head was read must sit ABOVE the cursor the
        // caller adopts — never inside the range it believes it has covered, which
        // is what reading the head last would have produced.
        await writer.insert("notes", { archived: false, body: "b", priority: 1, slug: "b" });

        const next = await writer.cdcChangedTables?.(head);

        expect(next?.tables).toStrictEqual(["notes"]);
        expect(next?.cursor).toBeGreaterThan(head);
    });

    it("reports no visibility when CDC is disabled, rather than throwing", async () => {
        expect.assertions(1);

        const writer = createSqlCtxDb({ clock: () => 1, dialect: makeSqliteDialect(), exec: harness.exec, schema });

        // `undefined` is the contract's "fall back to re-reading" signal — the
        // behaviour every caller had before this method existed.
        const blind = await writer.cdcChangedTables?.(0);

        expect(blind).toBeUndefined();
    });

    it("applies a key prefix to the changelog index only where the engine demands one", async () => {
        expect.assertions(4);

        /** Captures the DDL a writer renders, so the index can be asserted without a MySQL engine to run it on. */
        const capturingExec = (): { exec: SqlCtxExec; statements: string[] } => {
            const statements: string[] = [];

            return {
                exec: {
                    all: (query) => {
                        statements.push(query);

                        return Promise.resolve([]);
                    },
                    run: (query) => {
                        statements.push(query);

                        return Promise.resolve();
                    },
                },
                statements,
            };
        };

        const createIndexFor = async (indexKeyPrefix?: SqlDialect["indexKeyPrefix"]): Promise<string> => {
            const { exec, statements } = capturingExec();

            await createSqlCtxDb({ cdc: true, clock: () => 1, dialect: { ...makeSqliteDialect(), indexKeyPrefix }, exec, schema }).insert("notes", {
                archived: false,
                body: "a",
                priority: 1,
                slug: "a",
            });

            return statements.find((statement) => /create index .*__cdc_log_table_seq/iu.test(statement)) ?? "";
        };

        // MySQL's `key` type is VARCHAR(768) BECAUSE 768 utf8mb4 characters is
        // InnoDB's single-column index limit — so a composite `("table", seq)`
        // built without a prefix is over that limit and the migration fails with
        // ER_TOO_LONG_KEY. The prefix bounds `table`'s contribution; `seq` is an
        // integer and must never carry one.
        // Asserted on the column list rather than the whole statement: the index
        // NAME contains "table_seq", so a looser pattern matches itself.
        // The column list is what follows the first `(` after `ON <table>` — not
        // the last `(`, which on the prefixed form is the prefix's own.
        const columnsOf = (statement: string): string => statement.slice(statement.indexOf("(", statement.indexOf(" ON ")) + 1, statement.lastIndexOf(")"));

        const prefixed = await createIndexFor(() => 191);
        const plain = await createIndexFor();

        expect(columnsOf(prefixed)).toBe(`"table"(191), "seq"`);
        expect(prefixed).toMatch(/__cdc_log_table_seq/u);

        // An engine that indexes text directly gets the whole column, and `seq` —
        // an integer — is never prefixed on either.
        expect(columnsOf(plain)).toBe(`"table", "seq"`);
        expect(plain).not.toMatch(/\(191\)/u);
    });
});
