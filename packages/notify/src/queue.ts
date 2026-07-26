import { LunoraError } from "@lunora/errors";

import type { BroadcastResult, LunoraPush, PushContent, SubscriptionFilter } from "./types";

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
 *
 * RETRY SEMANTICS: retry is gated on `failed` — the count of TRANSIENT delivery
 * errors (a provider 5xx / network fault worth another attempt). When at least one
 * recipient `failed`, the job is RE-THROWN so the queue does NOT ack it and its
 * normal retry/backoff (and, on exhaustion, dead-letter) applies. A broadcast with
 * zero `failed` resolves and is acked — this includes the all-`pruned` case (every
 * device had unsubscribed: `sent:0`, `failed:0`, `pruned:N`), which is a SUCCESSFUL
 * prune, not a failure, so throwing on it would spuriously retry and pressure the
 * DLQ; and the empty audience (zero `total`), which has nothing to retry. Note a
 * retry re-runs the WHOLE broadcast, re-sending to the already-delivered recipients
 * (broadcast is not idempotent) — the accepted cost of getting the transiently
 * failed ones redelivered.
 */
export const runPushBroadcastJob = async (push: LunoraPush, job: PushBroadcastJob): Promise<BroadcastResult> => {
    const result = await push.broadcast(job.payload, job.filter);

    if (result.failed > 0) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/notify: push broadcast had ${result.failed.toString()} transient failure(s) of ${result.total.toString()} subscription(s) (${result.sent.toString()} sent, ${result.pruned.toString()} pruned) — throwing so the queue retries`,
        );
    }

    return result;
};
