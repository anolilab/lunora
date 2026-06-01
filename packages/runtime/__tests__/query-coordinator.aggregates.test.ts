import { describe, expect, test } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry, type FanOutRequest, mergeStrategyForAggregate } from "../src/query-coordinator.js";
import type { ShardNamespaceLike } from "../src/resolve-shard.js";

/**
 * Cross-shard aggregate merge — `count` / `aggregate({sum/max/min})` /
 * `groupBy` fan-outs collapse per-shard payloads via the
 * {@link MergeStrategy} so the coordinator can serve a global answer over a
 * shardBy table. `avg` is explicitly unsupported in v1 and surfaces a
 * `CirrusError`.
 */

interface ShardSpy {
    namespace: ShardNamespaceLike;
}

const createShards = (responses: Record<string, unknown>): ShardSpy => {
    const stubFor = (shardKey: string) => ({
        async fetch(): Promise<Response> {
            const value = responses[shardKey];

            return Response.json(value, { status: 200 });
        },
    });

    const namespace: ShardNamespaceLike = {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => ({ __name: name }),
    };

    return { namespace };
};

const buildRequest = (overrides: Partial<FanOutRequest>): FanOutRequest => ({
    args: {},
    fanOut: { merge: { kind: "sum" }, table: "messages" },
    functionPath: "messages:list",
    ...overrides,
});

describe("cross-shard merge — count + aggregate(sum/max/min)", () => {
    test("count fans out as sum", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const spy = createShards({ a: 3, b: 5, c: 2 });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<number>(spy.namespace, buildRequest({ fanOut: { merge: { kind: "sum" }, table: "messages" } }));

        expect(result.data).toBe(10);
        expect(result.ok).toBe(3);
    });

    test("max picks the largest per-shard scalar", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const spy = createShards({ a: 7, b: 99, c: 42 });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<number>(spy.namespace, buildRequest({ fanOut: { merge: { kind: "max" }, table: "messages" } }));

        expect(result.data).toBe(99);
    });

    test("min picks the smallest per-shard scalar", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b", "c"] });
        const spy = createShards({ a: 7, b: 99, c: 42 });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<number>(spy.namespace, buildRequest({ fanOut: { merge: { kind: "min" }, table: "messages" } }));

        expect(result.data).toBe(7);
    });

    test("min / max return null when every shard payload is non-numeric", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const spy = createShards({ a: null, b: null });
        const coordinator = createQueryCoordinator({ registry });

        const maxResult = await coordinator.fanOut(spy.namespace, buildRequest({ fanOut: { merge: { kind: "max" }, table: "messages" } }));
        const minResult = await coordinator.fanOut(spy.namespace, buildRequest({ fanOut: { merge: { kind: "min" }, table: "messages" } }));

        expect(maxResult.data).toBeNull();
        expect(minResult.data).toBeNull();
    });
});

describe("cross-shard merge — groupBy", () => {
    test("groupBy(sum) reduces per-shard entries into one per distinct key", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const spy = createShards({
            a: [
                { key: { channelId: "c1" }, value: 4 },
                { key: { channelId: "c2" }, value: 1 },
            ],
            b: [
                { key: { channelId: "c1" }, value: 7 },
                { key: { channelId: "c3" }, value: 2 },
            ],
        });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>(
            spy.namespace,
            buildRequest({ fanOut: { merge: { kind: "groupBy" }, table: "messages" } }),
        );

        const sorted = [...result.data].sort((left, right) => String(left.key["channelId"]).localeCompare(String(right.key["channelId"])));

        expect(sorted).toEqual([
            { key: { channelId: "c1" }, value: 11 },
            { key: { channelId: "c2" }, value: 1 },
            { key: { channelId: "c3" }, value: 2 },
        ]);
    });

    test("groupBy(max) reduces with max across shards", async () => {
        expect.assertions(1);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const spy = createShards({
            a: [{ key: { channelId: "c1" }, value: 4 }],
            b: [{ key: { channelId: "c1" }, value: 11 }],
        });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>(
            spy.namespace,
            buildRequest({ fanOut: { merge: { kind: "groupBy", op: "max" }, table: "messages" } }),
        );

        expect(result.data).toEqual([{ key: { channelId: "c1" }, value: 11 }]);
    });

    test("groupBy treats keys canonically (property order doesn't matter)", async () => {
        expect.assertions(2);

        const registry = createStaticShardRegistry({ messages: ["a", "b"] });
        const spy = createShards({
            a: [{ key: { a: 1, b: 2 }, value: 5 }],
            b: [{ key: { b: 2, a: 1 }, value: 3 }],
        });
        const coordinator = createQueryCoordinator({ registry });

        const result = await coordinator.fanOut<ReadonlyArray<{ key: Record<string, unknown>; value: null | number }>>(
            spy.namespace,
            buildRequest({ fanOut: { merge: { kind: "groupBy" }, table: "messages" } }),
        );

        expect(result.data).toHaveLength(1);
        expect(result.data[0]?.value).toBe(8);
    });
});

describe("mergeStrategyForAggregate", () => {
    test("count → sum", () => {
        expect.assertions(1);

        expect(mergeStrategyForAggregate({ kind: "count" })).toEqual({ kind: "sum" });
    });

    test("aggregate(sum) → sum, max → max, min → min", () => {
        expect.assertions(3);

        expect(mergeStrategyForAggregate({ kind: "scalar", op: "sum" })).toEqual({ kind: "sum" });
        expect(mergeStrategyForAggregate({ kind: "scalar", op: "max" })).toEqual({ kind: "max" });
        expect(mergeStrategyForAggregate({ kind: "scalar", op: "min" })).toEqual({ kind: "min" });
    });

    test("aggregate(avg) throws — needs sum + count separately", () => {
        expect.assertions(1);

        expect(() => mergeStrategyForAggregate({ kind: "scalar", op: "avg" })).toThrow(/avg/);
    });

    test("groupBy → groupBy with op-derived reducer (default sum)", () => {
        expect.assertions(2);

        expect(mergeStrategyForAggregate({ kind: "groupBy" })).toEqual({ kind: "groupBy", op: "sum" });
        expect(mergeStrategyForAggregate({ agg: { op: "max" }, kind: "groupBy" })).toEqual({ kind: "groupBy", op: "max" });
    });

    test("groupBy(avg) throws", () => {
        expect.assertions(1);

        expect(() => mergeStrategyForAggregate({ agg: { op: "avg" }, kind: "groupBy" })).toThrow(/avg/);
    });
});
