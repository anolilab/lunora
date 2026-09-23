import { beforeEach, describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ObservabilityEvent } from "../src/observability";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * `/_lunora/rpc-batch` must reach the SAME trace decision as `/_lunora/rpc`:
 * one head verdict for the whole batch, propagated to the shard so its spans
 * join this trace, and applied to every per-entry event so a sampled-out batch
 * exports nothing.
 */

interface ShardSpy {
    calls: { request: Request; shardKey: string }[];
    namespace: ShardNamespaceLike;
    respond: (entries: { id: unknown }[]) => Response;
}

/** The batched entries a sub-request carries, read off its (cloned) body. */
const readEntries = async (request: { json: () => Promise<unknown> }): Promise<{ id: unknown }[]> => {
    const body = await request.json();

    return (body as { calls: { id: unknown }[] }).calls;
};

/** A shard stub that echoes one 200 result per batched entry. */
const createBatchShardSpy = (): ShardSpy => {
    const calls: { request: Request; shardKey: string }[] = [];

    const spy = {
        calls,
        respond: (entries) =>
            Response.json(
                {
                    results: entries.map((entry) => {
                        return { body: { value: 1 }, id: entry.id, status: 200 };
                    }),
                },
                {
                    headers: { "content-type": "application/json" },
                    status: 200,
                },
            ),
    } as ShardSpy;

    spy.namespace = {
        get: (id) => {
            const shardKey = (id as { __name: string }).__name;

            return {
                fetch: async (request: Request) => {
                    const clone = request.clone();

                    calls.push({ request, shardKey });

                    return spy.respond(await readEntries(clone));
                },
            };
        },
        idFromName: (name) => {
            return { __name: name };
        },
    };

    return spy;
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const batchRequest = (): Request =>
    new Request("https://app.example/_lunora/rpc-batch", {
        body: JSON.stringify({
            calls: [
                { args: {}, functionPath: "messages:list", id: 0 },
                { args: {}, functionPath: "messages:count", id: 1 },
            ],
        }),
        method: "POST",
    });

describe("/_lunora/rpc-batch — trace context and head sampling", () => {
    let shard: ShardSpy;
    let seen: ObservabilityEvent[];

    beforeEach(() => {
        shard = createBatchShardSpy();
        seen = [];
    });

    it("exports no entry event when the batch's trace is sampled out", async () => {
        expect.assertions(2);

        const worker = createWorker({
            observability: { onRpc: (event) => seen.push(event) },
            sampling: { headRate: 0 },
            shardDO: shard.namespace,
        });

        const response = await worker.fetch(batchRequest(), {}, fakeContext);

        expect(response.status).toBe(200);
        expect(seen).toStrictEqual([]);
    });

    it("propagates a traceparent and the tail-bias toggle to the shard sub-request", async () => {
        expect.assertions(4);

        const worker = createWorker({ observability: { onRpc: (event) => seen.push(event) }, shardDO: shard.namespace });

        await worker.fetch(batchRequest(), {}, fakeContext);

        expect(shard.calls).toHaveLength(1);

        const forwarded = shard.calls[0]!.request.headers;

        expect(forwarded.get("traceparent")).toMatch(/^00-[\da-f]{32}-[\da-f]{16}-01$/);
        expect(forwarded.get("x-lunora-sample-errors")).toBe("1");
        // Every entry event lands in the trace we propagated.
        expect(new Set(seen.map((event) => event.traceId))).toStrictEqual(new Set([forwarded.get("traceparent")!.slice(3, 35)]));
    });

    it("keeps a sampled-out batch's errored entries, unless the tail bias is off", async () => {
        expect.assertions(3);

        const failing = (entries: { id: unknown }[]): Response =>
            Response.json(
                {
                    results: entries.map((entry) => {
                        return { body: {}, id: entry.id, status: 500 };
                    }),
                },
                {
                    headers: { "content-type": "application/json" },
                    status: 500,
                },
            );

        shard.respond = failing;

        const kept = createWorker({
            observability: { onRpc: (event) => seen.push(event) },
            sampling: { headRate: 0 },
            shardDO: shard.namespace,
        });

        await kept.fetch(batchRequest(), {}, fakeContext);

        expect(seen).toHaveLength(2);
        expect(seen.every((event) => !event.ok)).toBe(true);

        // The mirror: with errors NOT force-kept, a sampled-out batch exports
        // nothing at all — the gate is real, not "keep everything".
        const dropped: ObservabilityEvent[] = [];
        const worker = createWorker({
            observability: { onRpc: (event) => dropped.push(event) },
            sampling: { alwaysSampleErrors: false, headRate: 0 },
            shardDO: shard.namespace,
        });

        await worker.fetch(batchRequest(), {}, fakeContext);

        expect(dropped).toStrictEqual([]);
    });
});
