import type { AggregateIndexDefinitionLike } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `insert` against a schema with an `aggregateIndex` (`byProject`): the counter
 * companion update fires inline per write. Subtract the bare-insert baseline to
 * price the aggregate-maintenance path. One scenario per file with its own writer
 * (see `write-throughput-insert-bare.bench.ts`).
 */
const byProject: AggregateIndexDefinitionLike = { by: ["projectId"], name: "byProject", on: "todos", op: "count" };

const schema: SchemaLike = {
    tables: {
        todos: {
            aggregateIndexes: [byProject],
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const writer = makeWriter(schema);
let counter = 0;

describe("write throughput — aggregateIndex insert", () => {
    bench("+ aggregateIndex: insert (counter companion updates inline)", async () => {
        counter += 1;
        await writer.insert("todos", { _id: `a${String(counter)}`, projectId: "p1", seq: counter });
    });
});
