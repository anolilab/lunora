import type { LunoraPush, PushContent, SubscriptionFilter } from "./types";

/**
 * A broadcast job body — the JSON-serialisable payload enqueued for off-request
 * fan-out. Shaped to travel through a `@lunora/queue` producer/consumer without
 * `@lunora/notify` depending on `@lunora/queue` (the seam stays structural).
 */
export interface PushBroadcastJob {
    /** Subscription filter (which devices/users to target). */
    filter?: SubscriptionFilter;
    /** The push payload to deliver (the `to` target is derived per subscription). */
    payload: PushContent;
    /** Discriminator so a shared queue can multiplex message kinds. */
    type: "lunora.push.broadcast";
}

/** The structural slice of a `@lunora/queue` producer (`ctx.queues.&lt;name>`) used here. */
export interface QueueProducerLike {
    send: (body: PushBroadcastJob) => Promise<void>;
}

/**
 * Enqueue a fan-out broadcast for background delivery through a `@lunora/queue`
 * queue instead of blocking the request. Pair with {@link runPushBroadcastJob} in
 * the queue consumer.
 *
 * ```ts
 * // in a mutation/action:
 * await enqueuePushBroadcast(ctx.queues.push, { payload: { title: "New drop", body: "…" } });
 *
 * // in lunora/queues.ts consumer:
 * export const push = defineQueue({ async handler(batch, ctx) {
 *     for (const message of batch.messages) await runPushBroadcastJob(ctx.push, message.body);
 * }});
 * ```
 */
export const enqueuePushBroadcast = (queue: QueueProducerLike, job: Omit<PushBroadcastJob, "type">): Promise<void> =>
    queue.send({ ...job, type: "lunora.push.broadcast" });

/**
 * Run an enqueued broadcast job on the consumer side, delivering through the push
 * facade (which reuses the engine's retry + circuit-breaker middleware and prunes
 * gone subscriptions).
 */
export const runPushBroadcastJob = (push: LunoraPush, job: PushBroadcastJob): Promise<unknown> => push.broadcast(job.payload, job.filter);
