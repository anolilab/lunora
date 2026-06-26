import { beforeAll, bench, describe } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `replace` (full-row substitute) against the bare table. The seed row is created
 * once in `beforeAll` and only ever replaced (the `_id` is preserved), so it
 * survives CodSpeed's many re-runs. Own writer, one scenario per file (see
 * `write-throughput-insert-bare.bench.ts`).
 */
const SEED_ID = "seed";

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

describe("write throughput — bare replace", () => {
    beforeAll(async () => {
        await writer.insert("todos", { _id: SEED_ID, projectId: "p1", seq: 0 });
    });

    bench("bare: replace (full-row substitute on seed row)", async () => {
        counter += 1;
        await writer.replace(SEED_ID, { _id: SEED_ID, projectId: "p1", seq: counter });
    });
});
