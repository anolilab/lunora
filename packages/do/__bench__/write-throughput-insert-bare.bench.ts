import type { SchemaLike } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import { makeWriter } from "./shared";

/**
 * Write baseline — `insert` against a bare JSON-blob table (no triggers, no
 * aggregateIndex, no rankIndex). The "what's the SQL write actually cost?"
 * reading; subtract it from the indexed variants to price each maintenance path.
 *
 * One scenario per file with its own isolated writer (visulima `__bench__`
 * convention): CodSpeed's instrumented runner re-runs each bench body many times
 * and shares suite fixtures across benches, so a writer mutated by a sibling
 * bench corrupts the measurement.
 */
const schema: SchemaLike = {
    tables: {
        todos: {
            indexes: [],
            shape: { projectId: { kind: "string" }, seq: { kind: "number" } },
        },
    },
};

const writer = makeWriter(schema);
let counter = 0;

describe("write throughput — bare insert", () => {
    bench("bare: insert (no triggers, no indexes)", async () => {
        counter += 1;
        await writer.insert("todos", { _id: `b${String(counter)}`, projectId: "p1", seq: counter });
    });
});
