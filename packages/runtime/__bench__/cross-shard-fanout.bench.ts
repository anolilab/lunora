import { bench, describe } from "vitest";

import type { FanOutRequest } from "../src/query-coordinator.js";
import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * `fanOut` orchestrates a cross-shard read: dispatch in parallel, collect
 * per-shard payloads, collapse via the {@link MergeStrategy}. The interesting
 * scaling factor is **N shards** — the bench fans out against in-memory
 * stubs that return instantly so the readout isolates the orchestration
 * + merge cost, not network IO.
 *
 *  - **sum** — scalar reduce over N numbers. The cheapest merge.
 *  - **topK** — keep the K largest from N×50 candidates. Allocates a sort.
 *  - **groupBy(sum)** — group-by reduce. Canonical-JSON key normalization
 *    runs per entry, so this is the priciest of the three.
 *
 * Bench N at 4 (typical multi-tenant root) and 64 (sharded-channel scale).
 * Per the §3.1 plan, `avg` is deliberately unsupported and not benched.
 */

interface ShardStub {
    namespace: ShardNamespaceLike;
}

const makeShardStub = (responses: Map<string, unknown>): ShardStub => {
    const stubFor = (shardKey: string) => {
 return {
        async fetch(): Promise<Response> {
            return Response.json(responses.get(shardKey) ?? null, { status: 200 });
        },
    };
};

    return {
        namespace: {
            get: (id) => stubFor((id as { __name: string }).__name),
            getByName: (name) => stubFor(name),
            idFromName: (name) => { return { __name: name }; },
        },
    };
};

const makeShardKeys = (count: number): string[] => Array.from({ length: count }, (_, index) => `s${String(index)}`);

const buildRequest = (overrides: Partial<FanOutRequest>): FanOutRequest => {
 return {
    args: {},
    fanOut: { merge: { kind: "sum" }, table: "messages" },
    functionPath: "messages:list",
    ...overrides,
};
};

/**
 * Build a synthetic per-key groupBy payload — `entriesPerShard` distinct
 * keys per shard. Mirrors a realistic "10 categories, every shard reports
 * each" workload.
 */
const buildGroupByPayload = (entriesPerShard: number): { key: Record<string, unknown>; value: number }[] =>
    Array.from({ length: entriesPerShard }, (_, index) => { return { key: { category: `cat-${String(index)}` }, value: 1 }; });

// Per-shard-count setup. Done at module load (vitest bench doesn't honour
// beforeAll the same way the test runner does — see existing benches).
interface Setup {
    coordinatorGroup: ReturnType<typeof createQueryCoordinator>;
    coordinatorSum: ReturnType<typeof createQueryCoordinator>;
    coordinatorTopK: ReturnType<typeof createQueryCoordinator>;
    groupStub: ShardStub;
    sumStub: ShardStub;
    topKStub: ShardStub;
}

const buildSetup = (count: number): Setup => {
    const shardKeys = makeShardKeys(count);
    const registry = createStaticShardRegistry({ messages: shardKeys });
    const sumResponses = new Map<string, unknown>(shardKeys.map((key) => [key, 1]));
    const topKResponses = new Map<string, unknown>(
        shardKeys.map((key) => [key, Array.from({ length: 50 }, (_, index) => { return { by: `m-${key}-${String(index)}`, value: index }; })]),
    );
    const groupResponses = new Map<string, unknown>(shardKeys.map((key) => [key, buildGroupByPayload(10)]));

    return {
        sumStub: makeShardStub(sumResponses),
        topKStub: makeShardStub(topKResponses),
        groupStub: makeShardStub(groupResponses),
        coordinatorSum: createQueryCoordinator({ registry }),
        coordinatorTopK: createQueryCoordinator({ registry }),
        coordinatorGroup: createQueryCoordinator({ registry }),
    };
};

const setup4 = buildSetup(4);
const setup64 = buildSetup(64);

describe("fanOut — 4 shards", () => {
    bench("sum merge: 4 scalars", async () => {
        await setup4.coordinatorSum.fanOut(setup4.sumStub.namespace, buildRequest({ fanOut: { merge: { kind: "sum" }, table: "messages" } }));
    });

    bench("topK merge: 4 shards × 50 candidates, keep top 10", async () => {
        await setup4.coordinatorTopK.fanOut(
            setup4.topKStub.namespace,
            buildRequest({ fanOut: { merge: { by: "value", direction: "desc", k: 10, kind: "topK" }, table: "messages" } }),
        );
    });

    bench("groupBy(sum) merge: 4 shards × 10 entries each", async () => {
        await setup4.coordinatorGroup.fanOut(
            setup4.groupStub.namespace,
            buildRequest({ fanOut: { merge: { kind: "groupBy", op: "sum" }, table: "messages" } }),
        );
    });
});

describe("fanOut — 64 shards", () => {
    bench("sum merge: 64 scalars", async () => {
        await setup64.coordinatorSum.fanOut(setup64.sumStub.namespace, buildRequest({ fanOut: { merge: { kind: "sum" }, table: "messages" } }));
    });

    bench("topK merge: 64 shards × 50 candidates, keep top 10", async () => {
        await setup64.coordinatorTopK.fanOut(
            setup64.topKStub.namespace,
            buildRequest({ fanOut: { merge: { by: "value", direction: "desc", k: 10, kind: "topK" }, table: "messages" } }),
        );
    });

    bench("groupBy(sum) merge: 64 shards × 10 entries each", async () => {
        await setup64.coordinatorGroup.fanOut(
            setup64.groupStub.namespace,
            buildRequest({ fanOut: { merge: { kind: "groupBy", op: "sum" }, table: "messages" } }),
        );
    });
});
