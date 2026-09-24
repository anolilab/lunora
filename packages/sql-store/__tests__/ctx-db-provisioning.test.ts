import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../src/ctx-db";
import { createSqlCtxDb } from "../src/ctx-db";
import type { SqlDialect } from "../src/dialect";

/**
 * Coverage for `SqlCtxDbOptions.provisionScope` — the memo that decides how
 * often the `CREATE TABLE/INDEX IF NOT EXISTS` sweep runs.
 *
 * Split out from `ctx-db.test.ts` because it needs none of that suite's real
 * `node:sqlite` harness: what is under test is how many DDL statements reach the
 * exec, so a recording exec that answers every read with no rows says everything
 * and says it without a database.
 */

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

/** SQLite storage affinity per declared column kind — the same mapping `@lunora/d1`'s real dialect uses. */
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

const sqliteDialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: {
        autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT",
        integer: "INTEGER",
        key: "TEXT",
        real: "REAL",
        text: "TEXT",
    },
    frameworkColumns: () => [
        { name: "id", type: "TEXT PRIMARY KEY" },
        { name: "_creationTime", type: "REAL NOT NULL" },
    ],
    isUniqueViolation: (error) => error instanceof Error && UNIQUE_VIOLATION_RE.test(error.message),
    maxTableColumns: 100,
    name: "sqlite",
    supportsFts5: false,
    supportsReturning: true,
    tableExists: (table) => sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`,
};

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

const schema: SchemaLike = {
    tables: {
        notes: {
            indexes: [],
            shape: { archived: col("boolean"), body: col("string"), slug: col("string", { unique: true }) },
            shardMode: { kind: "global" },
        },
    },
} as never;

const isCreateTable = (statement: string): boolean => /^create table/iu.test(statement);

/** A recording exec that answers every read with no rows, so only the DDL is interesting. */
const countingExec = (): { createTableCount: () => number; exec: SqlCtxExec } => {
    const statements: string[] = [];

    return {
        createTableCount: () => statements.filter((statement) => isCreateTable(statement)).length,
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
    };
};

describe("createSqlCtxDb — provisionScope", () => {
    it("re-runs the CREATE-IF-NOT-EXISTS sweep for every writer when no scope is given", async () => {
        // The per-instance memo is the historical behaviour, and it is what tests
        // rely on: they pair a fresh database with a reused schema object.
        expect.assertions(1);

        const { createTableCount, exec } = countingExec();

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, schema }).findMany("notes", {});

        const perWriter = createTableCount();

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, schema }).findMany("notes", {});

        expect(createTableCount()).toBe(perWriter * 2);
    });

    it("runs the sweep once across writers that share a scope", async () => {
        // Hosts build a writer per request (it carries the caller's identity and
        // D1 bookmark), so without a shared scope the whole sweep — one round trip
        // per global table and index — repeats on every request's first
        // `.global()` access. ~1s per request on a 50-table schema in `lunora dev`.
        expect.assertions(2);

        const { createTableCount, exec } = countingExec();
        const provisionScope = {};

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope, schema }).findMany("notes", {});

        const first = createTableCount();

        expect(first).toBeGreaterThan(0);

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope, schema }).findMany("notes", {});

        expect(createTableCount()).toBe(first);
    });

    it("keeps two scopes independent, so a second database is still provisioned", async () => {
        // The failure this pins is silent and remote from its cause: share one
        // scope across two databases and the second never gets its tables, which
        // surfaces much later as `no such table`.
        expect.assertions(1);

        const { createTableCount, exec } = countingExec();

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope: {}, schema }).findMany("notes", {});

        const first = createTableCount();

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope: {}, schema }).findMany("notes", {});

        expect(createTableCount()).toBe(first * 2);
    });

    it("single-flights concurrent first-callers onto one sweep", async () => {
        // The memo is recorded synchronously, before the sweep's first `await`,
        // so two writers racing a cold scope share the round trip instead of
        // issuing duplicate DDL. Calibrated against a lone writer rather than a
        // hard-coded count, so adding a companion migration can't silently
        // invalidate it.
        expect.assertions(1);

        const lone = countingExec();

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec: lone.exec, provisionScope: {}, schema }).findMany("notes", {});

        const raced = countingExec();
        const provisionScope = {};

        await Promise.all([
            createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec: raced.exec, provisionScope, schema }).findMany("notes", {}),
            createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec: raced.exec, provisionScope, schema }).findMany("notes", {}),
        ]);

        expect(raced.createTableCount()).toBe(lone.createTableCount());
    });

    it("evicts a failed sweep from the scope so the next writer retries", async () => {
        expect.assertions(2);

        let failNext = true;
        const statements: string[] = [];
        const exec: SqlCtxExec = {
            all: (query) => {
                statements.push(query);

                return Promise.resolve([]);
            },
            run: (query) => {
                if (failNext) {
                    failNext = false;

                    return Promise.reject(new Error("connection dropped"));
                }

                statements.push(query);

                return Promise.resolve();
            },
        };
        const provisionScope = {};

        await expect(createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope, schema }).findMany("notes", {})).rejects.toThrow(
            "connection dropped",
        );

        await createSqlCtxDb({ clock: () => 1, dialect: sqliteDialect, exec, provisionScope, schema }).findMany("notes", {});

        expect(statements.filter((statement) => isCreateTable(statement)).length).toBeGreaterThan(0);
    });
});
