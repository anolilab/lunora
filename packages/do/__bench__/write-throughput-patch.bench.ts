import { beforeAll, bench, describe } from "vitest";

import type { SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `patch` (single-field update) against the bare table. The seed row is created
 * once in `beforeAll` and only ever patched (never deleted), so it survives
 * CodSpeed's many re-runs of the bench body. Own writer, one scenario per file,
 * so no sibling bench mutates it — the source of the old "document not found:
 * seed" failure (see `write-throughput-insert-bare.bench.ts`).
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

describe("write throughput — bare patch", () => {
    beforeAll(async () => {
        await writer.insert("todos", { _id: SEED_ID, projectId: "p1", seq: 0 });
    });

    bench("bare: patch (single-field update on seed row)", async () => {
        counter += 1;
        await writer.patch(SEED_ID, { seq: counter });
    });
});
