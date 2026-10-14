import type { DatabaseWriterLike, SchemaLike } from "@lunora/shard-engine";
import { beforeAll, bench, describe } from "vitest";

import { makeWriter } from "./shared";

/**
 * `replace` (full-row substitute) against the bare table. The writer is built AND
 * seeded inside `beforeAll` — never at module scope: CodSpeed's instrumented
 * runner measures the bench body in a context that doesn't carry module-level
 * seed state, so a module-level seed row is absent at run time ("document not
 * found: seed"). See `write-throughput-patch.bench.ts`.
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

let writer: DatabaseWriterLike;
let counter = 0;

// Seed with `allowExplicitId` so the row lands under SEED_ID — the default
// insert path ignores an explicit `_id` and mints a fresh one, so without this
// `replace(SEED_ID, …)` throws "document not found". See
// `write-throughput-patch.bench.ts`.
beforeAll(async () => {
    writer = makeWriter(schema);
    await writer.insert("todos", { _id: SEED_ID, projectId: "p1", seq: 0 }, { allowExplicitId: true });
});

describe("write throughput — bare replace", () => {
    bench("bare: replace (full-row substitute on seed row)", async () => {
        counter += 1;
        await writer.replace(SEED_ID, { _id: SEED_ID, projectId: "p1", seq: counter });
    });
});
