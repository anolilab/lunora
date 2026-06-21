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
