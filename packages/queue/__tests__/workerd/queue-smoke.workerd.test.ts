/**
 * Real-workerd boot smoke for `@lunora/queue`.
 *
 * The Node unit suite exercises the producer/dispatcher against plain-object
 * doubles; this suite proves the same code boots and runs against the real
 * runtime objects. Covered: the typed `ctx.queues.<name>` producer sends
 * through a real Cloudflare `Queue` binding (Miniflare-backed); the generated
 * worker `queue()` consumer path (`dispatchQueueBatch`) consumes a real workerd
 * `MessageBatch` and its `ack()` disposition is visible to the runtime
 * (`getQueueResult`); and a produced message is actually delivered end-to-end
 * to the consumer.
 */
import { createExecutionContext, createMessageBatch, env, getQueueResult } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import createQueues from "../../src/create-queues";
import type { QueueBindingLike } from "../../src/types";
import type { SmokeBody } from "./test-worker";
import testWorker, { deliveries } from "./test-worker";

describe("@lunora/queue (workerd)", () => {
    it("ctx.queues producer sends through a real Queue binding", async () => {
        expect.hasAssertions();

        const queues = createQueues({ bindings: { smokeQueue: env.QUEUE_SMOKE_QUEUE as unknown as QueueBindingLike } });

        await expect(queues.smokeQueue!.send({ text: "from-producer" })).resolves.toBeUndefined();
        await expect(queues.smokeQueue!.sendBatch([{ body: { text: "batch-1" } }, { body: { text: "batch-2" } }])).resolves.toBeUndefined();
    });

    it("an undeclared queue name rejects with a directed error", async () => {
        expect.hasAssertions();

        const queues = createQueues({ bindings: { smokeQueue: env.QUEUE_SMOKE_QUEUE as unknown as QueueBindingLike } });

        await expect(queues.otherQueue!.send({ text: "nope" })).rejects.toThrow(/no queue named "otherQueue".*known queues: smokeQueue/);
    });

    it("queue() consumer dispatches a real MessageBatch and acks are visible to workerd", async () => {
        expect.hasAssertions();

        const before = deliveries.length;
        const batch = createMessageBatch<SmokeBody>("smoke-queue", [{ attempts: 1, body: { text: "hello" }, id: "smoke-msg-1", timestamp: new Date() }]);
        const context = createExecutionContext();

        await testWorker.queue(batch, env);

        // `getQueueResult` reads the ack/retry state the runtime recorded for
        // the batch — proving the handler's `message.ack()` reached workerd.
        const result = await getQueueResult(batch, context);

        expect(result.explicitAcks).toContain("smoke-msg-1");
        expect(result.retryMessages).toEqual([]);

        const consumed = deliveries.slice(before);

        expect(consumed).toEqual([{ attempts: 1, body: { text: "hello" }, id: "smoke-msg-1", queue: "smoke-queue" }]);
    });

    it("a produced message is delivered end-to-end to the push consumer", async () => {
        expect.hasAssertions();

        const before = deliveries.length;

        await env.QUEUE_SMOKE_QUEUE.send({ text: "end-to-end" });

        // Delivery is asynchronous (the runtime batches, then invokes the
        // worker's `queue()` export) — poll until the handler has seen it.
        await vi.waitFor(
            () => {
                expect(deliveries.slice(before).map((message) => message.body)).toContainEqual({ text: "end-to-end" });
            },
            { interval: 50, timeout: 5000 },
        );
    });
});
