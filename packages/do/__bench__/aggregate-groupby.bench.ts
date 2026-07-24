import type { AggregateIndexDefinitionLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";
import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "../src/ctx-db";

/**
 * `aggregate({ op: "sum"|"max"|"min" })` and `groupBy({ by })` are §3.1's
 * other half. The shape mirrors `count()` — indexed (counter row reads)
 * vs scan (SUM/MAX/MIN over the table) — but the work per row is more
 * (the scan path has to read the field, not just walk a count). Bench both:
 *
 * - **aggregate(sum)** — indexed (op="sum" counter) vs scan
 * (`SELECT SUM(json_extract(__doc__,'$.seq')) FROM todos`).
 * - **aggregate(max)** — same shape against an `op:"max"` index.
 * - **groupBy({by})** — indexed (read every counter row) vs scan
 * (GROUP BY in SQL).
 *
 * Row count: 10 000 across 10 projects so the scan and groupBy bench has
 * real cardinality to chew on.
 */

const ROW_COUNT = 10_000;
const PROJECTS = 10;

const sumByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "sumByProject",
    on: "todos",
    op: "sum",
};

const maxByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    field: "seq",
    name: "maxByProject",
    on: "todos",
    op: "max",
};

const countByProject: AggregateIndexDefinitionLike = {
    by: ["projectId"],
    name: "countByProject",
    on: "todos",
    op: "count",
};

const indexedSchema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [sumByProject, maxByProject, countByProject],
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const scanSchema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const makeWriter = (schema: SchemaLike): DatabaseWriterLike => {
    const harness = createSqliteExec();

    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ schema, sql: harness.sql });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed writes into the same DB
        await writer.insert("todos", {
            _id: `t${String(index)}`,
            projectId: `p${String(index % PROJECTS)}`,
            seq: index,
        });
    }
};

const indexedWriter = makeWriter(indexedSchema);
const scanWriter = makeWriter(scanSchema);

// Seed in beforeAll: CodSpeed's instrumented runner (@codspeed/vitest-plugin)
// runs each bench against the suite's beforeAll/beforeEach hooks but does NOT
// pick up module-top-level await state, so a top-level seed leaves the bench
// querying an empty DB. beforeAll is honored in both the plain `vitest bench`
// runner and CodSpeed's analysis runner.
beforeAll(async () => {
    await seed(indexedWriter);
    await seed(scanWriter);
});

describe("aggregate() — indexed vs scan", () => {
    bench("indexed: aggregate(sum, seq) by projectId", async () => {
        await indexedWriter.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p5" } });
    });

    bench("scan: aggregate(sum, seq) by projectId", async () => {
        await scanWriter.aggregate("todos", { field: "seq", op: "sum", where: { projectId: "p5" } });
    });

    bench("indexed: aggregate(max, seq) by projectId", async () => {
        await indexedWriter.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p5" } });
    });

    bench("scan: aggregate(max, seq) by projectId", async () => {
        await scanWriter.aggregate("todos", { field: "seq", op: "max", where: { projectId: "p5" } });
    });
});

describe("groupBy() — indexed vs scan", () => {
    bench("indexed: groupBy(projectId) — count (read every counter row)", async () => {
        await indexedWriter.groupBy("todos", { by: ["projectId"] });
    });

    bench("scan: groupBy(projectId) — count (SQL GROUP BY)", async () => {
        await scanWriter.groupBy("todos", { by: ["projectId"] });
    });
});
