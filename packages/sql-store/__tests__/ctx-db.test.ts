import { DatabaseSync } from "node:sqlite";

import type { SchemaLike, ValidatorLike } from "@lunora/do";
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
        frameworkColumns: () => [
            { name: "id", type: "TEXT PRIMARY KEY" },
            { name: "_creationTime", type: "REAL NOT NULL" },
        ],
        isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
        name,
        supportsFts5: true,
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
            const cursor = btoa(JSON.stringify(["0", 30, "a", "x"]));

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
