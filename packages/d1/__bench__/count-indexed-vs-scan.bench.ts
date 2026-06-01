import type { AggregateIndexDefinitionLike, DatabaseWriterLike, SchemaLike, ValidatorLike } from "@cirrus/do";
import { bench, describe } from "vitest";

import { createD1Exec } from "../__tests__/_helpers/node-sqlite-d1.js";
import { createD1CtxDb, runD1AggregateMigrations } from "../src/d1-ctx-db.js";

/**
 * D1 column-dialect mirror of `@cirrus/do/count-indexed-vs-scan`. The
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

const col = (kind: string): ValidatorLike => { return { _meta: { column: { notNull: true } }, kind }; };

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

    return createD1CtxDb({ clock: () => CLOCK, exec: harness.exec, schema });
};

const seed = async (writer: DatabaseWriterLike): Promise<void> => {
    for (let index = 0; index < ROW_COUNT; index += 1) {
        await writer.insert("todos", {
            _id: `t${String(index)}`,
            priority: "medium",
            projectId: `p${String(index % PROJECTS)}`,
        });
    }
};

const indexedWriter = await createWriter(makeSchema(byProject, total));

await seed(indexedWriter);

const scanWriter = await createWriter(makeSchema());

await seed(scanWriter);

describe("d1 count() — indexed vs scan", () => {
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
