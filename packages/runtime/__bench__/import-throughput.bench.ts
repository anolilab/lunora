import { bench, describe } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * `orchestrateImport` routes pre-bucketed batches to their owning shards in
 * parallel. The throughput question is "how fast can the coordinator dispatch
 * + roll up?" — the per-shard work is the user's payload validation +
 * `writer.insert(...)` loop, which the bench substitutes with an
 * instant-return stub so we isolate orchestration.
 *
 *  - **1 shard × 1000 rows** — single round-trip; the lower bound.
 *  - **4 shards × 250 rows** — typical multi-tenant fan-out.
 *  - **16 shards × 62 rows** — sharded-channel fan-out at higher N.
 *
 * Total payload is 1 000 rows in every case so the comparison is "shard
 * count vs. throughput" rather than "more work per call".
 */

const TOTAL_ROWS = 1000;

interface ShardStub {
    namespace: ShardNamespaceLike;
}

const makeShardStub = (): ShardStub => {
    const stub = {
        async fetch(): Promise<Response> {
            // Mirror the shape `runShardImport` returns: `{ inserted, errors,
            // conflicts }` so the coordinator's roll-up code path is real.
            return Response.json({ inserted: { todos: 0 }, errors: [], conflicts: 0 }, { status: 200 });
        },
    };

    return {
        namespace: {
            get: () => stub,
            getByName: () => stub,
            idFromName: (name) => { return { __name: name }; },
        },
    };
};

const buildBatches = (shardCount: number): { rows: { doc: Record<string, unknown>; table: string }[]; shardKey: string }[] => {
    const perShard = Math.ceil(TOTAL_ROWS / shardCount);

    return Array.from({ length: shardCount }, (_outer, shard) => {
 return {
        rows: Array.from({ length: perShard }, (_inner, index) => {
 return {
            doc: { _id: `t-s${String(shard)}-${String(index)}`, projectId: `p${String(shard)}`, seq: index },
            table: "todos",
        };
}),
        shardKey: `s${String(shard)}`,
    };
});
};

interface ImportSetup {
    batches: ReturnType<typeof buildBatches>;
    coordinator: ReturnType<typeof createQueryCoordinator>;
    namespace: ShardNamespaceLike;
}

const buildSetup = (shardCount: number): ImportSetup => {
    const stub = makeShardStub();
    const shardKeys = Array.from({ length: shardCount }, (_, index) => `s${String(index)}`);

    return {
        coordinator: createQueryCoordinator({ registry: createStaticShardRegistry({ todos: shardKeys }) }),
        namespace: stub.namespace,
        batches: buildBatches(shardCount),
    };
};

const setup1 = buildSetup(1);
const setup4 = buildSetup(4);
const setup16 = buildSetup(16);

describe("orchestrateImport — 1000-row payload, varying shard count", () => {
    bench("1 shard × 1000 rows (single round-trip)", async () => {
        await setup1.coordinator.orchestrateImport(setup1.namespace, { batches: setup1.batches });
    });

    bench("4 shards × 250 rows (typical fan-out)", async () => {
        await setup4.coordinator.orchestrateImport(setup4.namespace, { batches: setup4.batches });
    });

    bench("16 shards × 62 rows (sharded-channel scale)", async () => {
        await setup16.coordinator.orchestrateImport(setup16.namespace, { batches: setup16.batches });
    });
});
