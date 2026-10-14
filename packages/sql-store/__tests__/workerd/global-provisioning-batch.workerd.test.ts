/**
 * Batched `.global()` provisioning against a **real** D1 binding in workerd.
 *
 * The Node suite proves the planner against `node:sqlite` with a hand-written `batch`; what it cannot prove is that D1
 * accepts the catalog read the planner depends on, that `env.DB.batch` applies the DDL, and that a batch that fails
 * leaves nothing behind. D1 refuses some catalog reads outright (a correlated `pragma_table_info(m.name)` raises
 * `SQLITE_AUTH`), so a planner built on one would silently fall back to the sequential path here and every Node test
 * would still be green.
 *
 * Round trips are counted through the exec because that is the number that costs latency on D1: this is the proof that
 * the batched route actually ran rather than quietly deferring everything.
 */
import type { SchemaLike, ValidatorLike } from "@lunora/shard-engine";
import { env } from "cloudflare:test";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import type { SqlCtxExec } from "../../src/ctx-db";
import { runSqlGlobalTableMigrations } from "../../src/ctx-db-global-provisioning";
import type { SqlDialect } from "../../src/dialect";

const UNIQUE_VIOLATION_RE = /unique constraint failed/iu;
const SQL_AFFINITY: Record<string, string> = { boolean: "INTEGER", number: "REAL" };

const sqliteDialect: SqlDialect = {
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

const col = (kind: string, extra: Record<string, unknown> = {}): ValidatorLike => {
    return { _meta: { column: { notNull: true, ...extra } }, kind };
};

/** `count` tables under `prefix` (D1 storage is shared across the tests in this file), each with two indexes, every 4th with a bigint column. */
const schemaFor = (prefix: string, count: number): SchemaLike =>
    ({
        tables: Object.fromEntries(
            Array.from({ length: count }, (_, index) => [
                `${prefix}${String(index)}`,
                {
                    indexes: [
                        { fields: ["owner"], name: "by_owner" },
                        { fields: ["done", "score"], name: "by_state" },
                    ],
                    shape: {
                        done: col("boolean"),
                        owner: col("string"),
                        score: col("number"),
                        title: col("string"),
                        ...(index % 4 === 0 ? { amount: col("bigint") } : {}),
                    },
                    shardMode: { kind: "global" },
                },
            ]),
        ),
    }) as never;

/** An exec over the real D1 binding that counts every call into it and routes `batch` to `env.DB.batch`. */
const d1Exec = (options: { withBatch: boolean }): { exec: SqlCtxExec; trips: () => number } => {
    let trips = 0;

    return {
        exec: {
            all: async (query, parameters) => {
                trips += 1;

                const result = await env.DB.prepare(query)
                    .bind(...parameters)
                    .all();

                return result.results;
            },
            ...(options.withBatch
                ? {
                      batch: async (statements: ReadonlyArray<{ params: ReadonlyArray<unknown>; sql: string }>) => {
                          trips += 1;
                          await env.DB.batch(statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params)));
                      },
                  }
                : {}),
            run: async (query, parameters) => {
                trips += 1;
                await env.DB.prepare(query)
                    .bind(...parameters)
                    .run();
            },
        },
        trips: () => trips,
    };
};

const catalogOf = async (prefix: string): Promise<string[]> => {
    const rows = await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE ? ORDER BY type, name")
        .bind(`${prefix}%`)
        .all<{ name: string; sql: string; type: string }>();

    return rows.results.map((row) => `${row.type} ${row.name} ${row.sql}`);
};

describe("batched .global() provisioning on D1 in workerd", () => {
    it("provisions in a handful of round trips and ends in the same database as the sequential path", async () => {
        expect.assertions(3);

        const batched = d1Exec({ withBatch: true });
        const sequential = d1Exec({ withBatch: false });

        await runSqlGlobalTableMigrations(batched.exec, schemaFor("wb_b", 20), sqliteDialect);
        await runSqlGlobalTableMigrations(sequential.exec, schemaFor("wb_s", 20), sqliteDialect);

        // One catalog read and a few batches against well over a hundred round trips one statement at a time.
        expect(batched.trips()).toBeLessThanOrEqual(6);
        expect(sequential.trips()).toBeGreaterThan(100);

        // Same DDL either way (the names differ only by prefix).
        const fromBatched = await catalogOf("wb_b");
        const fromSequential = await catalogOf("wb_s");

        expect(fromBatched.map((line) => line.replaceAll("wb_b", "T"))).toEqual(fromSequential.map((line) => line.replaceAll("wb_s", "T")));
    });

    it("is a no-op the second time: the catalog read and no write", async () => {
        expect.assertions(1);

        const first = d1Exec({ withBatch: true });

        await runSqlGlobalTableMigrations(first.exec, schemaFor("wb_n", 8), sqliteDialect);

        const second = d1Exec({ withBatch: true });

        await runSqlGlobalTableMigrations(second.exec, schemaFor("wb_n", 8), sqliteDialect);

        // sqlite_master, then the marker table's rows (the schema has bigint columns).
        expect(second.trips()).toBe(2);
    });

    it("rolls a failed batch back whole", async () => {
        expect.assertions(2);

        await expect(env.DB.batch([env.DB.prepare('CREATE TABLE "wb_rollback" ("id" TEXT)'), env.DB.prepare("THIS IS NOT SQL")])).rejects.toThrow(
            /syntax error/u,
        );

        const survivor = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'wb_rollback'").all();

        expect(survivor.results).toHaveLength(0);
    });
});
