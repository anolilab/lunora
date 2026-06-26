import { beforeAll, bench, describe } from "vitest";

import type { DatabaseWriterLike, SchemaLike } from "../src/ctx-db";
import { makeWriter } from "./shared";

/**
 * `patch` (single-field update) against the bare table. The writer is built AND
 * the seed row inserted inside `beforeAll` — never at module scope: CodSpeed's
 * instrumented runner measures the bench body in a context that does not carry
 * module-level seed state, so a module-level writer's seed row is absent when the
 * body runs ("document not found: seed"). Building it in `beforeAll` puts the
 * seed in the same context the measured run uses.
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

describe("write throughput — bare patch", () => {
    beforeAll(async () => {
        writer = makeWriter(schema);
        await writer.insert("todos", { _id: SEED_ID, projectId: "p1", seq: 0 });
    });

    bench("bare: patch (single-field update on seed row)", async () => {
        counter += 1;
        await writer.patch(SEED_ID, { seq: counter });
    });
});
