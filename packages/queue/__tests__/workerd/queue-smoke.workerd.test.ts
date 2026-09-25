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
import testWorker, { declineDeliveries, deliveries } from "./test-worker";

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

    // A `409 DISPATCH_IN_PROGRESS` means the message's first attempt is still
    // running on the shard. The broker has no uncounted retry, so an immediate
    // redelivery just meets the same decline: with `max_retries: 2` and no DLQ,
    // three deliveries within a second or so and the message is gone while its
    // work may still be running (or may yet fail). The retry has to wait the
    // decline out instead — the claim cannot outlive its fifteen-minute ceiling.
    it("a declined message is retried after the in-flight claim ceiling, not redelivered into the same decline", async () => {
        expect.hasAssertions();

        await env.QUEUE_DECLINE_QUEUE.send({ text: "slow-action" });

        await vi.waitFor(
            () => {
                expect(declineDeliveries).not.toHaveLength(0);
            },
            { interval: 50, timeout: 5000 },
        );

        const [first] = declineDeliveries;

        // Long enough for the broker to redeliver several times at the default zero retry delay.
        await new Promise((resolve) => {
            setTimeout(resolve, 3000);
        });

        // COUNT: one delivery, then the message is parked on a delayed retry — not three and dropped.
        // (The delay's value is asserted in the Node suite: `getQueueResult` does not report `delaySeconds`.)
        expect(declineDeliveries.filter((delivery) => delivery.id === first!.id)).toHaveLength(1);
    }, 15_000);
});
