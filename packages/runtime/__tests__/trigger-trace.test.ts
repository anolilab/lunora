import { describe, expect, it } from "vitest";

import type { ExecutionContextLike } from "../src/create-worker";
import { createWorker } from "../src/create-worker";
import type { ShardNamespaceLike } from "../src/resolve-shard";

/**
 * A queue batch and a cron fire carry no inbound `traceparent`, so the runtime
 * mints one for the trigger event. It then has to HAND that trace to the work it
 * drives: without it the trigger span is a childless root and every function the
 * handler invokes opens its own unrelated trace, which is the shape a distributed
 * trace exists to prevent.
 */

/** A W3C `traceparent`, captured so its trace/span ids can be compared. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/u;

interface ShardSpy {
    calls: { shardKey: string; traceparent: string | null }[];
    namespace: ShardNamespaceLike;
}

const createShardSpy = (): ShardSpy => {
    const calls: { shardKey: string; traceparent: string | null }[] = [];

    return {
        calls,
        namespace: {
            get: (id) => {
                const shardKey = (id as { __name: string }).__name;

                return {
                    fetch: async (request: Request) => {
                        calls.push({ shardKey, traceparent: request.headers.get("traceparent") });

                        return new Response("ok", { status: 200 });
                    },
                };
            },
            idFromName: (name) => {
                return { __name: name };
            },
        },
    };
};

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

const CRON = "*/30 * * * *";

describe("createWorker — trigger trace propagation", () => {
    it("propagates the cron trigger's trace to every function it dispatches", async () => {
        expect.assertions(4);

        const shard = createShardSpy();
        const spans: { spanId?: string; traceId?: string }[] = [];

        const worker = createWorker({
            cronJobs: { [CRON]: [{ args: {}, functionPath: "digests:flush", name: "flush digests" }] },
            observability: {
                onRpc: (event) => {
                    spans.push({ spanId: event.spanId, traceId: event.traceId });
                },
            },
            shardDO: shard.namespace,
        });

        await worker.scheduled({ cron: CRON, scheduledTime: 0 }, {}, fakeContext);

        const forwarded = shard.calls[0]?.traceparent;
        const match = TRACEPARENT.exec(forwarded ?? "");

        expect(forwarded).not.toBeNull();
        expect(match).not.toBeNull();
        // The ids on the wire are the TRIGGER's own — the cron span is the parent
        // of the work, not a childless root beside it.
        expect(match?.[1]).toBe(spans[0]?.traceId);
        expect(match?.[2]).toBe(spans[0]?.spanId);
    });

    it("hands the queue consumer the trigger's traceparent", async () => {
        expect.assertions(3);

        const shard = createShardSpy();
        const seen: string[] = [];
        const spans: { spanId?: string; traceId?: string }[] = [];

        const worker = createWorker({
            observability: {
                onRpc: (event) => {
                    spans.push({ spanId: event.spanId, traceId: event.traceId });
                },
            },
            queue: async (_batch, _env, _context, trigger) => {
                seen.push(trigger.traceparent);
            },
            shardDO: shard.namespace,
        });

        await worker.queue?.({ messages: [], queue: "emails" }, {}, fakeContext);

        const match = TRACEPARENT.exec(seen[0] ?? "");

        expect(match).not.toBeNull();
        expect(match?.[1]).toBe(spans[0]?.traceId);
        expect(match?.[2]).toBe(spans[0]?.spanId);
    });

    it("forwards an inbound traceparent from scheduler dispatch onto the shard call", async () => {
        expect.assertions(1);

        const shard = createShardSpy();
        const worker = createWorker({ adminToken: "admin-token", shardDO: shard.namespace });

        const inbound = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

        await worker.fetch(
            new Request("https://app.test/_lunora/scheduler/dispatch", {
                body: JSON.stringify({ args: {}, functionPath: "digests:flush" }),
                headers: { authorization: "Bearer admin-token", "content-type": "application/json", traceparent: inbound }, // gitleaks:allow
                method: "POST",
            }),
            {},
            fakeContext,
        );

        // The trigger's `ctx.run` POSTs here; without forwarding, the shard minted a
        // fresh trace and the dispatched function was an orphan.
        expect(shard.calls[0]?.traceparent).toBe(inbound);
    });
});
