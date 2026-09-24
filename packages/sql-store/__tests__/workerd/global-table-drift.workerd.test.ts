/**
 * `alterGlobalTableDrift`'s column probe, against a **real** D1 binding in workerd.
 *
 * The Node suites cover the same path on `node:sqlite`, and that is exactly why
 * this one has to exist: the two SQLite builds disagree about the statement the
 * probe gates on. `node:sqlite` builds with `SQLITE_DQS=0`, so a double-quoted
 * name that resolves to no column raises; workerd and D1 build the
 * double-quoted-string misfeature in, so an **unqualified** one is silently
 * reinterpreted as a string literal and the `SELECT` succeeds. A probe written
 * that way reports "no drift" for every table on the only runtime this path
 * runs on, `ALTER TABLE … ADD COLUMN` never runs, and a Node suite cannot see it.
 *
 * Both directions are asserted, because one case alone cannot tell a working
 * probe from one stuck on a single answer: a probe that always threw would pass
 * the drift case and re-`ALTER` a healthy table forever.
 *
 * Each test owns a table name rather than a database — D1 storage is shared
 * across the tests in this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { runSqlGlobalTableMigrations } from "../../src/ctx-db-migrations";
import type { SqlDialect } from "../../src/dialect";
import { OCC_VERSION_COLUMN } from "../../src/sql-exec";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;

/** SQLite storage affinity per declared column kind — the mapping `@lunora/d1`'s real dialect uses. */
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

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

/** One `.global()` table declaring two field columns on top of the framework ones. */
const schemaFor = (table: string): SchemaLike =>
    ({
        tables: { [table]: { indexes: [], shape: { body: col("string"), slug: col("string") }, shardMode: { kind: "global" } } },
    }) as never;

/** A `SqlCtxExec` over the real D1 binding that records every statement it is handed. */
const recordingExec = (): { exec: SqlCtxExec; statements: string[] } => {
    const statements: string[] = [];

    return {
        exec: {
            all: async (query, parameters) => {
                statements.push(query);

                const result = await env.DB.prepare(query)
                    .bind(...parameters)
                    .all();

                return result.results;
            },
            run: async (query, parameters) => {
                statements.push(query);

                await env.DB.prepare(query)
                    .bind(...parameters)
                    .run();
            },
        },
        statements,
    };
};

/**
 * The table's stored `CREATE TABLE` text, as `ALTER TABLE … ADD COLUMN` rewrites it.
 *
 * Read from `sqlite_master`, not `pragma_table_info`: D1's authorizer refuses
 * pragma table-valued functions through the binding, and a check that cannot run
 * proves nothing.
 */
const tableDdl = async (table: string): Promise<string> => {
    const row = await env.DB.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();

    return row?.sql ?? "";
};

const addColumnStatements = (statements: ReadonlyArray<string>): string[] => statements.filter((statement) => /add column/iu.test(statement));

describe("global table drift on D1 in workerd", () => {
    it("adds the columns a table provisioned against an older schema is missing", async () => {
        expect.assertions(4);

        const table = "drifted_notes";

        // The shape a table provisioned before `_version` and before `slug` was
        // declared actually carries.
        await env.DB.prepare(`CREATE TABLE "${table}" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "body" TEXT NOT NULL)`).run();

        const { exec, statements } = recordingExec();

        await runSqlGlobalTableMigrations(exec, schemaFor(table), sqliteDialect);

        const ddl = await tableDdl(table);

        // The OCC version column is the one with a live read path behind it: the
        // guarded-write CAS reads it on every `patch`/`replace`/`delete`.
        expect(ddl).toContain(`"${OCC_VERSION_COLUMN}"`);
        expect(ddl).toContain(`"slug"`);
        // `body` was already there and must not be re-added.
        expect(addColumnStatements(statements)).toHaveLength(2);
        expect(ddl).toContain(`"body"`);
    });

    it("attempts no DDL against a table that already carries every column", async () => {
        expect.assertions(2);

        const table = "current_notes";

        await env.DB.prepare(
            `CREATE TABLE "${table}" ("id" TEXT PRIMARY KEY, "_creationTime" REAL NOT NULL, "${OCC_VERSION_COLUMN}" INTEGER, "body" TEXT NOT NULL, "slug" TEXT NOT NULL)`,
        ).run();

        const { exec, statements } = recordingExec();

        await runSqlGlobalTableMigrations(exec, schemaFor(table), sqliteDialect);

        // A probe stuck on "throws" would pass the drift case above and land here:
        // `ADD COLUMN` on a column that exists fails, and the failure is not caught.
        expect(addColumnStatements(statements)).toStrictEqual([]);
        await expect(tableDdl(table)).resolves.toContain(`"slug" TEXT NOT NULL`);
    });
});
