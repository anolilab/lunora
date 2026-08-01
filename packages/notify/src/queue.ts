import { LunoraError } from "@lunora/errors";

import type { BroadcastPageResult, LunoraPush, PushContent, SubscriptionFilter } from "./types";

/**
 * A broadcast job body — the JSON-serialisable payload enqueued for off-request
 * fan-out. Shaped to travel through a `@lunora/queue` producer/consumer without
 * `@lunora/notify` depending on `@lunora/queue` (the seam stays structural).
 * `filter.after`, when set, resumes a broadcast partway through (see
 * {@link runPushBroadcastJob}'s continuation semantics).
 */
export interface PushBroadcastJob {
    /** Subscription filter (which devices/users to target; `filter.after` resumes a paged broadcast). */
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
 * the queue consumer — see its doc comment for how a large audience continues
 * across MULTIPLE messages (one bounded page per message), not one.
 *
 * ```ts
 * // in a mutation/action:
 * await enqueuePushBroadcast(ctx.queues.push, { payload: { title: "New drop", body: "…" } });
 *
 * // in lunora/queues.ts consumer:
 * export const push = defineQueue({ async handler(batch, ctx) {
 *     for (const message of batch.messages) {
 *         const { nextCursor } = await runPushBroadcastJob(ctx.push, message.body);
 *
 *         if (nextCursor !== undefined) {
 *             // More pages remain — enqueue the continuation. Each message still
 *             // does only ONE bounded page of work.
 *             await enqueuePushBroadcast(ctx.queues.push, {
 *                 payload: message.body.payload,
 *                 filter: { ...message.body.filter, after: nextCursor },
 *             });
 *         }
 *     }
 * }});
 * ```
 */
export const enqueuePushBroadcast = (queue: QueueProducerLike, job: Omit<PushBroadcastJob, "type">): Promise<void> =>
    queue.send({ ...job, type: "lunora.push.broadcast" });

/**
 * Run ONE bounded page of an enqueued broadcast job on the consumer side,
 * delivering through the push facade's {@link LunoraPush.broadcastPage} (which
 * reuses the engine's retry + circuit-breaker middleware and prunes gone
 * subscriptions).
 *
 * RETRY / CONTINUATION SEMANTICS (rewritten for plan 222 / NOTIFY-01 — a
 * broadcast job used to process the WHOLE audience in one message, which could
 * exceed Worker CPU/wall limits for a large audience and made a retry re-run
 * everything):
 *
 * - A job now processes exactly ONE bounded page (see `CreateNotifyOptions`'s
 * page-size option, default 250, or `job.filter.limit` when smaller),
 * keyset-paginated on the subscription `id` (see `SubscriptionFilter.after`)
 * — so per-message work is bounded regardless of total audience size.
 * - Retry is still gated on `result.failed` — the count of TRANSIENT delivery
 * errors (a provider 5xx / network fault worth another attempt). When at
 * least one recipient in THIS PAGE `failed`, the job is RE-THROWN so the
 * queue does NOT ack it and its normal retry/backoff (and, on exhaustion,
 * dead-letter) applies — to just this page, not the whole broadcast.
 * - A page with zero `failed` resolves and is acked — this includes the
 * all-`pruned` case (every device on the page had unsubscribed:
 * `sent:0`, `failed:0`, `pruned:N`), which is a SUCCESSFUL prune, not a
 * failure, so throwing on it would spuriously retry and pressure the DLQ;
 * and the empty-page case (zero `total`), which has nothing to retry.
 * - The returned `nextCursor` is set when more pages remain. `@lunora/notify`
 * does NOT enqueue the continuation itself — it has no `@lunora/queue`
 * dependency (the seam stays structural) and no reference to the producer
 * that enqueued this message — so the CALLER (the `lunora/queues.ts`
 * consumer) is responsible for re-enqueueing with `filter.after: nextCursor`
 * when present. See the consumer example on {@link enqueuePushBroadcast}.
 * - A retry of a page redelivers only that page's already-delivered recipients
 * on a transient partial failure (a page is not individually idempotent) —
 * the accepted cost of getting the transiently failed ones redelivered, now
 * scoped to one page instead of the whole broadcast.
 */
export const runPushBroadcastJob = async (push: LunoraPush, job: PushBroadcastJob): Promise<BroadcastPageResult> => {
    const page = await push.broadcastPage(job.payload, job.filter);

    if (page.result.failed > 0) {
        throw new LunoraError(
            "INTERNAL",
            `@lunora/notify: push broadcast page had ${page.result.failed.toString()} transient failure(s) of ${page.result.total.toString()} subscription(s) (${page.result.sent.toString()} sent, ${page.result.pruned.toString()} pruned) — throwing so the queue retries this page`,
        );
    }

    return page;
};
