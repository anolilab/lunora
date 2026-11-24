/**
 * Cold-start migration catalog, index-ledger, and read-only FTS5 probe
 * invariants over a real Durable Object's `state.storage.sql` (measuring
 * workerd's `cursor.rowsRead` and `cursor.rowsWritten` counters).
 */
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { runShardMigrations } from "../../src/ctx-db-migrations";
import type { SchemaLike } from "../../src/schema-types";
import type { SqlHarness } from "../_helpers/sql-harness";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

const buildWideSchema = (): SchemaLike => {
    const tables: Record<string, unknown> = {};

    for (let tableIndex = 0; tableIndex < 8; tableIndex += 1) {
        const shape: Record<string, unknown> = { body: { kind: "string" }, expiresAt: { kind: "number" } };
        const indexes: { fields: string[]; name: string; unique?: boolean }[] = [];

        for (let fieldIndex = 0; fieldIndex < 4; fieldIndex += 1) {
            const field = `field${String(fieldIndex)}`;

            shape[field] = { kind: "string" };
            indexes.push({ fields: [field], name: `by_${field}`, unique: fieldIndex === 0 });
        }

        tables[`items_${String(tableIndex)}`] = {
            indexes,
            searchIndexes: tableIndex === 0 ? [{ field: "body", name: "by_body" }] : undefined,
            shape,
            ttlPolicy: tableIndex === 0 ? { field: "expiresAt" } : undefined,
        };
    }

    return { tables } as SchemaLike;
};

interface WakeMeasurement {
    catalogScans: number;
    ftsProbes: number;
    ledgerScans: number;
    rowsRead: number;
    rowsWritten: number;
}

const measureWake = (sql: SqlHarness["sql"], run: (measuredSql: SqlHarness["sql"]) => void): WakeMeasurement => {
    const cursors: { rowsRead?: unknown; rowsWritten?: unknown }[] = [];
    let catalogScans = 0;
    let ledgerScans = 0;
    let ftsProbes = 0;

    // A fresh wrapper without `WRAPPED_SQL` acts like a brand-new post-hibernation
    // DO storage handle for per-handle WeakMap caches (such as FTS5 availability).
    const measuredSql: SqlHarness["sql"] = {
        exec: <Row = Record<string, unknown>>(query: string, ...bindings: unknown[]) => {
            if (query.includes("sqlite_master")) {
                catalogScans += 1;
            }

            if (query.includes("SELECT") && query.includes("__lunora_framework_indexes")) {
                ledgerScans += 1;
            }

            if (query.includes("__lunora_fts_probe")) {
                ftsProbes += 1;
            }

            const cursor = sql.exec<Row>(query, ...bindings);

            cursors.push(cursor as { rowsRead?: unknown; rowsWritten?: unknown });

            return cursor;
        },
    };

    run(measuredSql);

    // Read `cursor.rowsRead` / `cursor.rowsWritten` AFTER the pass has consumed
    // every cursor: workerd increments both counters lazily during iteration.
    let rowsRead = 0;
    let rowsWritten = 0;

    for (const cursor of cursors) {
        if (typeof cursor.rowsRead === "number") {
            rowsRead += cursor.rowsRead;
        }

        if (typeof cursor.rowsWritten === "number") {
            rowsWritten += cursor.rowsWritten;
        }
    }

    return { catalogScans, ftsProbes, ledgerScans, rowsRead, rowsWritten };
};

let harness: SqlHarness;

describe("runShardMigrations single-pass catalog and ledger on workerd SQLite", () => {
    beforeEach(() => {
        harness = createWorkerdExec();
    });

    it("scans sqlite_master and the index ledger once with zero writes on post-hibernation wakes and repairs dropped indexes", () => {
        expect.assertions(8);

        const schema = buildWideSchema();
        const options = { cdc: true, schemaSnapshot: { hash: "w1", json: '{"tables":{}}' } };

        runShardMigrations(harness.sql, schema, options);

        const wake = measureWake(harness.sql, (measuredSql) => {
            runShardMigrations(measuredSql, schema, options);
        });

        expect(wake.catalogScans).toBe(1);
        expect(wake.ledgerScans).toBe(1);
        expect(wake.ftsProbes).toBe(0);
        expect(wake.rowsWritten).toBe(0);
        expect(wake.rowsRead).toBeGreaterThan(0);
        // 8 tables × 4 declared indexes + companions produces ~90 catalog rows and 33 ledger rows.
        // Without single-pass catalog + ledger scans this wake read > 3,500 rows.
        expect(wake.rowsRead).toBeLessThan(300);

        harness.sql.exec(`DROP INDEX "items_0_by_field1"`);

        expect(harness.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'items_0_by_field1'`).toArray()).toStrictEqual([]);

        runShardMigrations(harness.sql, schema, options);

        expect(harness.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'items_0_by_field1'`).toArray()).toHaveLength(1);
    });
});
