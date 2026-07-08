/**
 * Cloudflare Queues — added by `lunora add queue`.
 *
 * Declare push or pull consumers with `defineQueue`. Codegen discovers
 * exports from this file and generates:
 *   - Typed `ctx.queues.<name>.send(...)` producers on Mutation/Action ctx
 *   - A `queue()` export in the Worker entry (push consumers)
 *   - wrangler.jsonc `queues.producers[]` and `queues.consumers[]` entries
 *
 * Usage (from a mutation):
 *   await ctx.queues.emailQueue.send({ to: "user@example.com" });
 */
import { defineQueue } from "@lunora/queue";
import type { QueueBatch } from "@lunora/queue";

/**
 * A sample email queue. Push consumer: every message triggers the handler
 * below, which runs inside the Worker (no external consumer needed).
 * Tune `maxBatchSize`, `maxRetries`, etc. in the config.
 */
export const emailQueue = defineQueue<{ to: string; subject: string; body: string }>({
    handler: async (ctx, batch: QueueBatch<{ to: string; subject: string; body: string }>) => {
        for (const message of batch.messages) {
            // Replace with an internal mutation — see `lunora add mail`
            console.log(`sending to ${message.body.to}: ${message.body.subject}`);
            message.ack();
        }
    },
    maxRetries: 3,
});
