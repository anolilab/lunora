import type { RankIndexDefinitionLike } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `insert` against a schema with a `rankIndex` (`byChannel`): the rank companion
 * table + sort-key index update inline per write. Subtract the bare-insert
 * baseline to price the rank-maintenance path. One scenario per file with its own
 * writer (see `write-throughput-insert-bare.bench.ts`).
 */
const byChannel: RankIndexDefinitionLike = {
    name: "byChannel",
    on: "todos",
    partitionBy: ["projectId"],
    sortBy: [{ direction: "asc", field: "seq" }],
};

const schema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            rankIndexes: [byChannel],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const writer = makeWriter(schema);
let counter = 0;

describe("write throughput — rankIndex insert", () => {
    bench("+ rankIndex: insert (rank companion + sort-key index updates inline)", async () => {
        counter += 1;
        await writer.insert("todos", { _id: `r${String(counter)}`, projectId: "p1", seq: counter });
    });
});
