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

/** The span id half of a `traceparent`, or `undefined` when the header is absent/malformed. */
const spanIdOf = (traceparent: null | string): string | undefined => traceparent?.split("-")[2];

/** A batch whose entries are spread across three distinct shards. */
const shardedBatchRequest = (): Request =>
    new Request("https://app.example/_lunora/rpc-batch", {
        body: JSON.stringify({
            calls: [
                { args: {}, functionPath: "messages:list", id: 0, shardKey: "tenant-a" },
                { args: {}, functionPath: "messages:count", id: 1, shardKey: "tenant-a" },
                { args: {}, functionPath: "messages:list", id: 2, shardKey: "tenant-b" },
                { args: {}, functionPath: "messages:list", id: 3, shardKey: "tenant-c" },
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

    // Every shard in a batch runs its OWN dispatch, so each has to be told a
    // distinct span id. Handed the same one, each instrumented shard adopts it
    // as its dispatch root (`resolveTraceAnchor` takes the inbound
    // `parentSpanId`), and then stamps it onto its `lunora.dispatch` wide event,
    // its `ctx.log` records and the parent of every `ctx.trace` child — so two
    // shards put different work on the wire under one `(traceId, spanId)`.
    //
    // Three shards, not two: a pairwise check written against a two-shard
    // fixture passes while a third collides.
    it("gives every shard in the batch its own span id", async () => {
        expect.assertions(2);

        const worker = createWorker({
            // A batch addressing non-default shard keys is default-denied without this.
            allowUnauthenticatedShardAccess: true,
            observability: { onRpc: (event) => seen.push(event) },
            shardDO: shard.namespace,
        });

        await worker.fetch(shardedBatchRequest(), {}, fakeContext);

        const perShardSpanIds = shard.calls.map((call) => spanIdOf(call.request.headers.get("traceparent")));

        expect(perShardSpanIds).toHaveLength(3);
        expect(new Set(perShardSpanIds).size).toBe(perShardSpanIds.length);
    });

    // The whole-batch invariant, asserted over the set rather than by comparing
    // ids by hand: nothing the worker puts on the wire, and nothing it tells a
    // shard to call itself, may share an id with anything else in the batch.
    it("emits no two spans sharing a (traceId, spanId) across the whole batch", async () => {
        expect.assertions(3);

        const worker = createWorker({
            // A batch addressing non-default shard keys is default-denied without this.
            allowUnauthenticatedShardAccess: true,
            observability: { onRpc: (event) => seen.push(event) },
            shardDO: shard.namespace,
        });

        await worker.fetch(shardedBatchRequest(), {}, fakeContext);

        const perShardSpanIds = shard.calls.map((call) => spanIdOf(call.request.headers.get("traceparent")));
        const everySpanId = [...perShardSpanIds, ...seen.map((event) => event.spanId)];

        // One entry event per call, plus one sub-request per distinct shard.
        expect(everySpanId).toHaveLength(7);
        expect(everySpanId.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
        expect(new Set(everySpanId).size).toBe(everySpanId.length);
    });

    // Each entry hangs off the span its OWN shard was told to use, so the
    // waterfall groups a batch by the hop that actually carried it rather than
    // flattening every entry under one bar.
    it("parents each entry event to the span id its own shard received", async () => {
        // The shard-key set, the distinctness check, then one per shard.
        expect.assertions(5);

        const worker = createWorker({
            // A batch addressing non-default shard keys is default-denied without this.
            allowUnauthenticatedShardAccess: true,
            observability: { onRpc: (event) => seen.push(event) },
            shardDO: shard.namespace,
        });

        await worker.fetch(shardedBatchRequest(), {}, fakeContext);

        const spanIdByShard = new Map<string | undefined, string | undefined>(
            shard.calls.map((call) => [call.shardKey, spanIdOf(call.request.headers.get("traceparent"))]),
        );
        const parentByShard = new Map(seen.map((event) => [event.shardKey, event.parentSpanId]));

        expect([...parentByShard.keys()].toSorted((a, b) => String(a).localeCompare(String(b)))).toStrictEqual(["tenant-a", "tenant-b", "tenant-c"]);
        // Distinct parents, checked before the per-shard match below: with one
        // span id shared by every sub-request, that match holds trivially and
        // this test would pass against the very shape it exists to catch.
        expect(new Set(parentByShard.values()).size).toBe(3);

        for (const [shardKey, parentSpanId] of parentByShard) {
            expect(parentSpanId).toBe(spanIdByShard.get(shardKey));
        }
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
