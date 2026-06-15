import { describe, expect, it } from "vitest";

import { createQueryCoordinator, createStaticShardRegistry } from "../src/query-coordinator";
import type { ShardNamespaceLike } from "../src/resolve-shard";

interface ShardCall {
    functionPath: string;
    shardKey: string;
}

/**
 * A fake shard namespace that serves `__lunora_admin__:getMetrics` per shard,
 * echoing a fixed lifetime `requests` total in the `{ result }` envelope the
 * real `handleAdminRpc` uses. A shard listed in `failing` returns a 500 so the
 * partial-failure path is exercised.
 */
const createMetricsNamespace = (
    requestsByShard: Record<string, number>,
    failing: ReadonlySet<string> = new Set(),
    calls: ShardCall[] = [],
): ShardNamespaceLike => {
    const stubFor = (shardKey: string) => {
        return {
            async fetch(request: Request): Promise<Response> {
                const body: { args?: Record<string, unknown>; functionPath: string } = await request.json();

                calls.push({ functionPath: body.functionPath, shardKey });

                if (failing.has(shardKey)) {
                    return new Response("boom", { status: 500 });
                }

                return Response.json({ result: { requests: requestsByShard[shardKey] ?? 0, shard: shardKey } }, { status: 200 });
            },
        };
    };

    return {
        get: (id) => stubFor((id as { __name: string }).__name),
        getByName: (name) => stubFor(name),
        idFromName: (name) => {
            return { __name: name };
        },
    };
};

describe("orchestrateShardTraffic", () => {
    it("fans getMetrics out across the live shards and returns per-shard request totals", async () => {
        expect.assertions(4);

        const calls: ShardCall[] = [];
        const namespace = createMetricsNamespace({ busy: 80, quiet: 20 }, new Set(), calls);
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["busy", "quiet"] }) });

        const result = await coordinator.orchestrateShardTraffic(namespace, { table: "messages" });

        expect(result.ok).toBe(2);
        expect(result.failed).toBe(0);
        expect(result.shards).toEqual([
            { requests: 80, shardKey: "busy" },
            { requests: 20, shardKey: "quiet" },
        ]);
        // It must fan the cheap metrics read, not some heavier op.
        expect(calls.every((call) => call.functionPath === "__lunora_admin__:getMetrics")).toBe(true);
    });

    it("reports a failed shard as requests:0 and keeps the rest (partial)", async () => {
        expect.assertions(3);

        const namespace = createMetricsNamespace({ busy: 90, down: 999, quiet: 10 }, new Set(["down"]));
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: ["busy", "down", "quiet"] }) });

        const result = await coordinator.orchestrateShardTraffic(namespace, { table: "messages" });

        expect(result.ok).toBe(2);
        expect(result.failed).toBe(1);
        // The failed shard still appears so the caller sees the full shard set,
        // but contributes 0 — it can't be the hot shard on missing data.
        expect(result.shards).toEqual([
            { requests: 90, shardKey: "busy" },
            { requests: 0, shardKey: "down" },
            { requests: 10, shardKey: "quiet" },
        ]);
    });

    it("returns an empty distribution when the table has no live shards", async () => {
        expect.assertions(1);

        const namespace = createMetricsNamespace({});
        const coordinator = createQueryCoordinator({ registry: createStaticShardRegistry({ messages: [] }) });

        const result = await coordinator.orchestrateShardTraffic(namespace, { table: "messages" });

        expect(result).toEqual({ failed: 0, ok: 0, shards: [] });
    });
});
