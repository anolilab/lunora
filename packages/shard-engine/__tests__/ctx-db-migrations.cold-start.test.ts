import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { SqlExec } from "../src/ctx-db";
import { readIdempotent, writeIdempotent } from "../src/ctx-db-idempotency";
import { runShardMigrations } from "../src/ctx-db-migrations";
import type { SchemaLike } from "../src/schema-types";
import createSqliteExec from "./_helpers/node-sqlite";

const buildWideSchema = (tableCount: number, indexesPerTable: number): SchemaLike => {
    const tables: Record<string, unknown> = {};

    for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
        const shape: Record<string, unknown> = { expiresAt: { kind: "number" } };
        const indexes: { fields: string[]; name: string; unique?: boolean }[] = [];

        for (let fieldIndex = 0; fieldIndex < indexesPerTable; fieldIndex += 1) {
            const field = `field${String(fieldIndex)}`;

            shape[field] = { kind: "string" };
            indexes.push({ fields: [field], name: `by_${field}`, unique: fieldIndex === 0 });
        }

        tables[`items_${String(tableIndex)}`] = {
            indexes,
            shape,
            ttlPolicy: tableIndex === 0 ? { field: "expiresAt" } : undefined,
        };
    }

    return { tables } as SchemaLike;
};

interface RecordedStats {
    ftsProbes: number;
    ftsReadChecks: number;
    ledgerScans: number;
    sqliteMasterScans: number;
    statements: string[];
}

const spySql = (inner: SqlExec): { sql: SqlExec; stats: RecordedStats } => {
    const stats: RecordedStats = { ftsProbes: 0, ftsReadChecks: 0, ledgerScans: 0, sqliteMasterScans: 0, statements: [] };
    const sql: SqlExec = {
        exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
            stats.statements.push(query);

            if (query.includes("sqlite_master")) {
                stats.sqliteMasterScans += 1;
            }

            if (query.includes("SELECT") && query.includes("__lunora_framework_indexes")) {
                stats.ledgerScans += 1;
            }

            if (query.includes("__lunora_fts_probe")) {
                stats.ftsProbes += 1;
            }

            if (query.includes("LIMIT 0") && query.includes("__fts_")) {
                stats.ftsReadChecks += 1;
            }

            return inner.exec<Row>(query, ...bindings);
        },
    };

    return { sql, stats };
};

const createSimulatedFtsWrapper = (inner: SqlExec, options: { ftsTable: string; readCheckThrows: boolean }): { sql: SqlExec; stats: RecordedStats } => {
    const { sql: spied, stats } = spySql(inner);
    const sql: SqlExec = {
        exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
            if (query.includes("SELECT type, name, tbl_name, sql FROM sqlite_master")) {
                const realRows = spied.exec(query, ...bindings).toArray();
                const syntheticRows = [
                    ...realRows,
                    {
                        name: options.ftsTable,
                        sql: `CREATE VIRTUAL TABLE "${options.ftsTable}" USING fts5(__text__, __id__ UNINDEXED)`,
                        tbl_name: options.ftsTable,
                        type: "table",
                    },
                ] as Row[];

                return {
                    [Symbol.iterator]: () => syntheticRows[Symbol.iterator](),
                    one: () => syntheticRows[0] as Row,
                    toArray: () => syntheticRows,
                };
            }

            if (query.includes(`"${options.ftsTable}"`) && query.includes("LIMIT 0")) {
                stats.ftsReadChecks += 1;

                if (options.readCheckThrows) {
                    throw new Error("no such module: fts5");
                }

                const empty: Row[] = [];

                return {
                    [Symbol.iterator]: () => empty[Symbol.iterator](),
                    one: () => undefined as Row,
                    toArray: () => empty,
                };
            }

            if (query.includes(`"${options.ftsTable}"`) && !query.includes("__lunora_fts_probe")) {
                const empty: Row[] = [];

                return {
                    [Symbol.iterator]: () => empty[Symbol.iterator](),
                    one: () => undefined as Row,
                    toArray: () => empty,
                };
            }

            return spied.exec<Row>(query, ...bindings);
        },
    };

    return { sql, stats };
};

let harness: ReturnType<typeof createSqliteExec>;

describe("runShardMigrations single-pass catalog and index ledger", () => {
    beforeEach(() => {
        harness = createSqliteExec();
    });

    afterEach(() => {
        harness.close();
    });

    it("reads sqlite_master and __lunora_framework_indexes exactly once per wake regardless of table or index count", () => {
        expect.assertions(4);

        const schema = buildWideSchema(5, 5);

        runShardMigrations(harness.sql, schema, { cdc: true });

        // Fresh wrapper handle simulates a post-hibernation wake on the same database.
        const { sql: wakeSql, stats } = spySql(harness.sql);

        runShardMigrations(wakeSql, schema, { cdc: true });

        expect(stats.sqliteMasterScans).toBe(1);
        expect(stats.ledgerScans).toBe(1);
        expect(stats.statements.some((query) => query.includes('INSERT OR IGNORE INTO "__lunora_framework_indexes"'))).toBe(false);
        expect(stats.statements.some((query) => query.includes("DROP INDEX"))).toBe(false);
    });

    it("tracks the default __by_creation index in the catalog so a unique _by_creation index replaces it on first start", () => {
        expect.assertions(2);

        const schema: SchemaLike = {
            tables: {
                items: {
                    indexes: [{ fields: ["code"], name: "_by_creation", unique: true }],
                    shape: { code: { kind: "string" } },
                },
            },
        };

        runShardMigrations(harness.sql, schema);

        const rows = harness.sql.exec<{ sql: null | string }>(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'items__by_creation'`).toArray();

        expect(rows).toHaveLength(1);
        expect(rows[0]?.sql).toContain("CREATE UNIQUE INDEX");
    });

    it("drops undeclared framework indexes and removes their ledger entries using the single-pass ledger", () => {
        expect.assertions(4);

        const initialSchema = buildWideSchema(2, 3);

        runShardMigrations(harness.sql, initialSchema);

        const reducedSchema = buildWideSchema(2, 1);
        const { sql: wakeSql, stats } = spySql(harness.sql);

        runShardMigrations(wakeSql, reducedSchema);

        expect(stats.sqliteMasterScans).toBe(1);
        expect(stats.ledgerScans).toBe(1);

        const remainingIndexes = harness.sql
            .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('items_0_by_field1', 'items_0_by_field2')`)
            .toArray();
        const remainingLedger = harness.sql
            .exec<{ name: string }>(`SELECT name FROM "__lunora_framework_indexes" WHERE name IN ('items_0_by_field1', 'items_0_by_field2')`)
            .toArray();

        expect(remainingIndexes).toStrictEqual([]);
        expect(remainingLedger).toStrictEqual([]);
    });

    it("verifies FTS5 read-only when an FTS5 table already exists and falls back to the DDL probe if the module is unavailable", () => {
        expect.assertions(4);

        const schema: SchemaLike = {
            tables: {
                notes: {
                    indexes: [],
                    searchIndexes: [{ field: "body", name: "by_body" }],
                    shape: { body: { kind: "string" } },
                },
            },
        };

        const healthy = createSimulatedFtsWrapper(harness.sql, { ftsTable: "notes__fts_by_body", readCheckThrows: false });

        runShardMigrations(healthy.sql, schema);

        expect(healthy.stats.ftsReadChecks).toBe(1);
        expect(healthy.stats.ftsProbes).toBe(0);

        const unsupported = createSimulatedFtsWrapper(harness.sql, { ftsTable: "notes__fts_by_body", readCheckThrows: true });

        runShardMigrations(unsupported.sql, schema);

        expect(unsupported.stats.ftsReadChecks).toBe(1);
        expect(unsupported.stats.ftsProbes).toBeGreaterThan(0);
    });

    it("isolates a failure building __idempotency_ts so cold starts stay healthy and the next wake retries", () => {
        expect.assertions(3);

        const schema = buildWideSchema(1, 1);

        runShardMigrations(harness.sql, schema);
        writeIdempotent(harness.sql, "user-1", "mut-1", JSON.stringify({ ok: true }), 1000);
        harness.sql.exec(`DROP INDEX IF EXISTS "__idempotency_ts"`);

        const failingSql: SqlExec = {
            exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
                if (query.includes("__idempotency_ts")) {
                    throw new Error("simulated index build failure");
                }

                return harness.sql.exec<Row>(query, ...bindings);
            },
        };

        expect(() => {
            runShardMigrations(failingSql, schema);
        }).not.toThrow();

        expect(readIdempotent(harness.sql, "user-1", "mut-1")?.resultJson).toBe(JSON.stringify({ ok: true }));

        runShardMigrations(harness.sql, schema);

        const rebuilt = harness.sql.exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = '__idempotency_ts'`).toArray();

        expect(rebuilt).toHaveLength(1);
    });
});
