/**
 * Cold-start migration wake cost on a real Durable Object's `state.storage.sql`,
 * measured with workerd's `cursor.rowsRead` and `cursor.rowsWritten` counters.
 * The shared invariants run in `_scenarios/ctx-db-migrations.cold-start`.
 */
import { aroundEach, beforeEach, describe, expect, it } from "vitest";

import { runShardMigrations } from "../../src/ctx-db-migrations";
import type { SchemaLike } from "../../src/schema-types";
import { spySql } from "../_helpers/ctx-db-migration-spy";
import type { SqlHarness } from "../_helpers/sql-harness";
import runColdStartScenarios from "../_scenarios/ctx-db-migrations.cold-start";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);

runColdStartScenarios(createWorkerdExec);

/** Eight tables with an FTS5 search index and a TTL on the first, so the wake exercises every index family. */
const buildSearchSchema = (): SchemaLike => {
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

/** Sums a counter over a run's cursors. Workerd counts rows lazily while a cursor is iterated, so call this only after the pass has consumed every cursor. */
const sumCursorCounter = (cursors: { rowsRead?: unknown; rowsWritten?: unknown }[], counter: "rowsRead" | "rowsWritten"): number => {
    let total = 0;

    for (const cursor of cursors) {
        const value = cursor[counter];

        if (typeof value === "number") {
            total += value;
        }
    }

    return total;
};

let harness: SqlHarness;

describe("runShardMigrations wake cost on workerd SQLite", () => {
    beforeEach(() => {
        harness = createWorkerdExec();
    });

    it("keeps a post-hibernation wake to bounded reads with zero writes and no FTS write probe", () => {
        expect.assertions(6);

        const schema = buildSearchSchema();
        const options = { cdc: true, schemaSnapshot: { hash: "w1", json: '{"tables":{}}' } };

        runShardMigrations(harness.sql, schema, options);

        const { sql: wakeSql, stats } = spySql(harness.sql);

        runShardMigrations(wakeSql, schema, options);

        const rowsRead = sumCursorCounter(stats.cursors, "rowsRead");

        expect(stats.sqliteMasterScans).toBe(1);
        expect(stats.ledgerScans).toBe(1);
        expect(stats.ftsProbes).toBe(0);
        expect(sumCursorCounter(stats.cursors, "rowsWritten")).toBe(0);
        expect(rowsRead).toBeGreaterThan(0);
        // 8 tables × 4 declared indexes + companions produces ~90 catalog rows and 33 ledger rows.
        // Without single-pass catalog + ledger scans this wake read > 3,500 rows.
        expect(rowsRead).toBeLessThan(300);
    });
});
