/**
 * `explain` on a `.global()` table, against a **real** D1 binding in workerd.
 *
 * `explain` prefixes the statement a read compiles to with `EXPLAIN QUERY PLAN`. D1 is SQLite behind
 * an authorizer that refuses some statements (it refuses pragma table-valued functions through the
 * binding), so whether it admits this one, and what shape its rows have, has to be asked of D1.
 * Each test owns a table name: D1 storage is shared across the tests in this file.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { createSqlCtxDb } from "../../src/ctx-db";
import type { SqlDialect } from "../../src/dialect";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

const d1Dialect: SqlDialect = {
    columnType: (kind) => SQL_AFFINITY[kind ?? ""] ?? "TEXT",
    companionTypes: { autoincrementPrimaryKey: "INTEGER PRIMARY KEY AUTOINCREMENT", integer: "INTEGER", key: "TEXT", real: "REAL", text: "TEXT" },
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

const d1Exec: SqlCtxExec = {
    all: async (query, parameters) => {
        const result = await env.DB.prepare(query)
            .bind(...parameters)
            .all();

        return result.results;
    },
    run: async (query, parameters) => {
        await env.DB.prepare(query)
            .bind(...parameters)
            .run();
    },
};

const schemaFor = (table: string): SchemaLike =>
    ({
        tables: {
            [table]: { indexes: [{ fields: ["room"], name: "by_room" }], shape: { body: col("string"), room: col("string") }, shardMode: { kind: "global" } },
        },
    }) as never;

describe("explain on D1", () => {
    it("reports the plan D1 chose, naming the index that serves the read", async () => {
        expect.assertions(3);

        const table = "explain_messages";
        const writer = createSqlCtxDb({ clock: () => 1, dialect: d1Dialect, exec: d1Exec, schema: schemaFor(table) });

        await writer.insert(table, { body: "hi", room: "lobby" });

        const indexed = await writer.explain?.(table, { where: { room: "lobby" } });
        const scanned = await writer.explain?.(table, { where: { body: "hi" } });

        expect(indexed?.plan.join("\n")).toContain("by_room");
        expect(scanned?.plan.length).toBeGreaterThan(0);
        expect(scanned?.plan.join("\n")).not.toContain("by_room");
    });
});
