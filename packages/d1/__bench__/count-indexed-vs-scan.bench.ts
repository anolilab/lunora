import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@lunora/do";
import { beforeAll, bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1";
import { createD1CtxDb as createD1ContextDatabase, runD1AggregateMigrations } from "../src/d1-ctx-db";

/**
 * D1 column-dialect mirror of `@lunora/do/count-indexed-vs-scan`. The
 * win shape should be the same — an aggregateIndex companion lookup is O(1)
 * vs SQL `SELECT COUNT(*)` walking the table — but the column-dialect
 * physical schema (real columns, not `json_extract`) gives the scan path a
 * different baseline than the JSON-blob path. We bench both so the §3.1
 * promise holds for global tables (which live in D1) as it does for
 * shard-local tables.
 */

const ROW_COUNT = 10_000;
const PROJECTS = 10;
const CLOCK = 1_700_000_000_000;

const col = (kind: string): ValidatorLike => {
    return { _meta: { column: { notNull: true } }, kind };
};

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
                indexes: [],
                shape: { priority: col("string"), projectId: col("string") },
            },
        },
    };
};

const createWriter = async (schema: SchemaLike): Promise<DatabaseWriterLike> => {
    const harness = createD1Exec();

    harness.ddl(
        `CREATE TABLE "todos" (
            "id" TEXT PRIMARY KEY,
            "_creationTime" INTEGER NOT NULL,
            "priority" TEXT,
            "projectId" TEXT
        )`,
    );

    await runD1AggregateMigrations(harness.exec, schema);

    return createD1ContextDatabase({ clock: () => CLOCK, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential seed: rows insert one at a time to keep deterministic _creationTime ordering
        await writer.insert("todos", {
            _id: `t${String(index)}`,
            priority: "medium",
            projectId: `p${String(index % PROJECTS)}`,
        });
    }
};

let indexedWriter: DatabaseWriterLike;
let scanWriter: DatabaseWriterLike;

describe("d1 count() — indexed vs scan", () => {
    // Build + seed in beforeAll: CodSpeed's instrumented runner does not pick up
    // module-top-level await state (async migrations + seed writes), so the
    // benches would otherwise hit an empty DB. beforeAll is honored by both the
    // plain `vitest bench` runner and CodSpeed's analysis runner.
    beforeAll(async () => {
        indexedWriter = await createWriter(makeSchema(byProject, total));
        await seed(indexedWriter);
        scanWriter = await createWriter(makeSchema());
        await seed(scanWriter);
    });

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
