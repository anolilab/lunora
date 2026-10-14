import type { SchemaLike, TriggerDefinitionLike } from "@lunora/shard-engine";
import { createShardCtxDb as createShardContextDatabase, runShardMigrations } from "@lunora/shard-engine";
import { bench, describe } from "vitest";

import createSqliteExec from "../__tests__/_helpers/node-sqlite";

/**
 * Per-write trigger-runner cost. Every aggregateIndex / rankIndex update
 * rides this path (the §3.1 maintenance fires from `runTriggers`), so the
 * absolute cost matters and shouldn't grow non-linearly with trigger count.
 *
 * - **0 triggers** — baseline insert; no trigger map.
 * - **1 trigger** — one after-insert no-op handler.
 * - **4 triggers** — four after-insert no-op handlers (writes fan out to
 * every matching trigger; this picks up dispatch overhead, not the work
 * inside each handler).
 *
 * Handlers are intentionally empty so the bench measures the runner +
 * trigger-payload construction, not user code.
 */

const noopHandler = async (): Promise<void> => {
    // No-op: we measure the dispatch path, not the handler body.
};

const triggerMap = (count: number): Record<string, TriggerDefinitionLike> => {
    const map: Record<string, TriggerDefinitionLike> = {};

    for (let index = 0; index < count; index += 1) {
        map[`noop${String(index)}`] = { handler: noopHandler, op: "insert", timing: "after" };
    }

    return map;
};

const schemaWithTriggers = (count: number): SchemaLike => {
    return {
        tables: {
            todos: {
                indexes: [],
                shape: { projectId: { kind: "string" } },
                triggerMap: count === 0 ? undefined : triggerMap(count),
            },
        },
    };
};

const makeWriter = (count: number) => {
    const harness = createSqliteExec();
    const schema = schemaWithTriggers(count);

    runShardMigrations(harness.sql, schema);

    return createShardContextDatabase({ schema, sql: harness.sql });
};

const writer0 = makeWriter(0);
const writer1 = makeWriter(1);
const writer4 = makeWriter(4);

let counter0 = 0;
let counter1 = 0;
let counter4 = 0;

describe("trigger runner — per-write fan-out cost", () => {
    bench("0 triggers (baseline insert)", async () => {
        counter0 += 1;
        await writer0.insert("todos", { _id: `t0-${String(counter0)}`, projectId: "p1" });
    });

    bench("1 after-insert no-op trigger", async () => {
        counter1 += 1;
        await writer1.insert("todos", { _id: `t1-${String(counter1)}`, projectId: "p1" });
    });

    bench("4 after-insert no-op triggers", async () => {
        counter4 += 1;
        await writer4.insert("todos", { _id: `t4-${String(counter4)}`, projectId: "p1" });
    });
});
