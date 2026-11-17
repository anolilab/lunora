import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * `count()` is the headline §3.1 win: an `aggregateIndex` lifts it from O(N)
 * (SCAN COUNT(*)) to O(1) (a single read of the counter companion table). We
 * bench both paths against a real SQLite engine so the win shows up at a
 * realistic row count.
 *
 * - **Indexed** — count("todos", { projectId: "p5" }) routes to the
 * aggregateIndex `byProject` companion → constant-time lookup.
 * - **Indexed (whole-table)** — count("todos") routes to the empty-`by`
 * aggregateIndex `total` → one row read regardless of N.
 * - **Scan** — same query against a schema with no aggregateIndex →
 * SELECT COUNT(*) FROM todos[ WHERE …]. Cost grows with N.
 *
 * Row count is 10 000 spread across 10 projects. SQLite is `:memory:` so
 * the bench measures the query path, not disk IO.
 */

const ROW_COUNT = 10_000;
const PROJECTS = 10;

const byProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "byProject",
    on: "todos",
    op: "count",
};

const total: AggregateIndexDefinitionLike = {
    by: [],
    name: "total",
    on: "todos",
    op: "count",
};

const makeSchema = (...indexes: AggregateIndexDefinitionLike[]): SchemaLike => {
    return {
        tables: {
            todos: {
                aggregateIndexes: indexes,
                indexes: [{ fields: ["projectId"], name: "by_project" }],
                shape: {
                    priority: { kind: "string" },
                    projectId: { kind: "string" },
                },
            },
        },
    };
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("todos", {
            _id: `t${String(index)}`,
            priority: "medium",
            projectId: `p${String(index % PROJECTS)}`,
        });
    }
};

// Synchronous engine/migration setup persists under CodSpeed; only the async
// seed must move into beforeAll.
const indexedHarness = createSqliteExec();
const indexedSchema = makeSchema(byProject, total);

runShardMigrations(indexedHarness.sql, indexedSchema);
const indexedWriter = createShardContextDatabase({ schema: indexedSchema, sql: indexedHarness.sql });

const scanHarness = createSqliteExec();
const scanSchema = makeSchema();

runShardMigrations(scanHarness.sql, scanSchema);
const scanWriter = createShardContextDatabase({ schema: scanSchema, sql: scanHarness.sql });

// Seed in a file-level beforeAll. CodSpeed's instrumented runner does not pick up module-top-level await state, and
// vitest's own bench runner skips hooks registered inside a `describe` (its `runBenchmarkSuite` recurses into
// sub-suites without running their hooks), which left every arm here timing a count over an empty table. A file-level
// hook runs under both.
beforeAll(async () => {
    await seed(indexedWriter);
    await seed(scanWriter);
});

describe("count() — indexed vs scan", () => {
    bench("indexed: count by projectId (companion lookup)", async () => {
        await indexedWriter.count("todos", { where: { projectId: "p5" } });
    });

    bench("scan: count by projectId (SELECT COUNT(*) … WHERE)", async () => {
        await scanWriter.count("todos", { where: { projectId: "p5" } });
    });

    bench("indexed: count whole table (empty-by counter)", async () => {
        await indexedWriter.count("todos");
    });

    bench("scan: count whole table (SELECT COUNT(*))", async () => {
        await scanWriter.count("todos");
    });
});
