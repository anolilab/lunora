import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runShardMigrations } from "../../src/ctx-db-migrations";
import { buildWideSchema, spySql } from "../_helpers/ctx-db-migration-spy";
import type { SqlHarness } from "../_helpers/sql-harness";

/**
 * Cold-start invariants on a warm shard, shared by the `node:sqlite` and workerd
 * runners: a wake reads `sqlite_master` and the index ledger once each, issues no
 * index DDL, and repairs an index that has gone missing. Runtime-only measurements
 * (workerd's row counters, node's simulated FTS5) stay in their runners.
 */

/** Runs the shared cold-start scenarios; `createHarness` supplies the SQLite of the runner calling it. */
const runColdStartScenarios = (createHarness: () => SqlHarness): void => {
    let harness: SqlHarness;

    describe("runShardMigrations cold start on a warm shard", () => {
        beforeEach(() => {
            harness = createHarness();
        });

        afterEach(() => {
            harness.close();
        });

        it("reads sqlite_master and the index ledger once per wake and issues no index DDL", () => {
            expect.assertions(4);

            const schema = buildWideSchema(5, 5);

            runShardMigrations(harness.sql, schema, { cdc: true });

            // A fresh wrapper stands in for a post-hibernation wake on the same database.
            const { sql: wakeSql, stats } = spySql(harness.sql);

            runShardMigrations(wakeSql, schema, { cdc: true });

            expect(stats.sqliteMasterScans).toBe(1);
            expect(stats.ledgerScans).toBe(1);
            expect(stats.statements.some((query) => query.includes('INSERT OR IGNORE INTO "__lunora_framework_indexes"'))).toBe(false);
            expect(stats.statements.some((query) => query.includes("DROP INDEX"))).toBe(false);
        });

        it("repairs an index dropped from a warm shard on the next wake", () => {
            expect.assertions(2);

            const schema = buildWideSchema(1, 2);

            runShardMigrations(harness.sql, schema);
            harness.sql.exec(`DROP INDEX "items_0_by_field1"`);

            expect(harness.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'items_0_by_field1'`).toArray()).toStrictEqual([]);

            runShardMigrations(harness.sql, schema);

            expect(harness.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'items_0_by_field1'`).toArray()).toHaveLength(1);
        });
    });
};

export default runColdStartScenarios;
