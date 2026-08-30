import { LunoraError } from "@lunora/errors";

import type { BroadcastOutcome, BroadcastPageResult, LunoraPush, PushContent, SubscriptionFilter } from "./types";

/**
 * A broadcast job body — the JSON-serialisable payload enqueued for off-request
 * fan-out. Shaped to travel through a `@lunora/queue` producer/consumer without
 * `@lunora/notify` depending on `@lunora/queue` (the seam stays structural).
 * `filter.after`, when set, resumes a broadcast partway through (see
 * {@link runPushBroadcastPage}'s continuation semantics).
 */
interface PushBroadcastJob {
    /** Subscription filter (which devices/users to target; `filter.after` resumes a paged broadcast). */
    filter?: SubscriptionFilter;
    /** The push payload to deliver (the `to` target is derived per subscription). */
    payload: PushContent;

    /**
     * Redeliver to exactly these subscription ids instead of walking a page —
     * an earlier page's {@link PushBroadcastPageOutcome.failedIds}. Set by the
     * consumer when it re-enqueues a page's transient failures; `filter` is
     * ignored on such a job. See {@link runPushBroadcastPage}.
     */
    retryIds?: string[];
    /** Discriminator so a shared queue can multiplex message kinds. */
    type: "lunora.push.broadcast";
}

/**
 * One page's outcome plus the ids that need redelivering.
 *
 * The consumer MUST act on BOTH fields: `nextCursor` continues the broadcast and
 * `failedIds` redelivers the recipients this page missed. Acking a message while
 * ignoring either silently drops part of the audience.
 */
interface PushBroadcastPageOutcome extends BroadcastPageResult {
    /**
     * Subscriptions that failed transiently on this run (gone/pruned devices are
     * NOT here — they are deleted, not retried). Re-enqueue a job carrying these
     * as `retryIds` to redeliver to just them.
     */
    failedIds: string[];
}

/**
 * The transiently-failed ids of a page — the set a `retryIds` job redelivers to.
 * Gone/pruned subscriptions never carry `status: "failed"`, so they are excluded
 * by construction.
 */
const failedIdsOf = (outcomes: ReadonlyArray<BroadcastOutcome>): string[] =>
    outcomes.filter((outcome) => outcome.status === "failed").map((outcome) => outcome.id);

/** The structural slice of a `@lunora/queue` producer (`ctx.queues.<name>`) used here. */
interface QueueProducerLike {
    send: (body: PushBroadcastJob) => Promise<void>;
}

/**
 * Enqueue a fan-out broadcast for background delivery through a `@lunora/queue`
 * queue instead of blocking the request. Pair with {@link runPushBroadcastPage} in
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
 *         const { failedIds, nextCursor } = await runPushBroadcastPage(ctx.push, message.body);
 *
 *         if (nextCursor !== undefined) {
 *             // More pages remain — enqueue the continuation. Each message still
 *             // does only ONE bounded page of work.
 *             await enqueuePushBroadcast(ctx.queues.push, {
 *                 payload: message.body.payload,
 *                 filter: { ...message.body.filter, after: nextCursor },
 *             });
 *         }
 *
 *         if (failedIds.length > 0) {
 *             // Redeliver ONLY the recipients that failed — never the whole page.
 *             await enqueuePushBroadcast(ctx.queues.push, { payload: message.body.payload, retryIds: failedIds });
 *         }
 *
 *         message.ack();
 *     }
 * }});
 * ```
 */
const enqueuePushBroadcast = (queue: QueueProducerLike, job: Omit<PushBroadcastJob, "type">): Promise<void> =>
    queue.send({ ...job, type: "lunora.push.broadcast" });

/** Redeliver to an explicit set of subscription ids (a previous page's failures). */
const runRetryIds = async (push: LunoraPush, payload: PushContent, ids: ReadonlyArray<string>): Promise<PushBroadcastPageOutcome> => {
    const outcomes: BroadcastOutcome[] = [];

    for (const id of ids) {
        try {
            // eslint-disable-next-line no-await-in-loop -- a retry set is a handful of ids; serial keeps the failing provider unpressured
            const receipt = await push.send(id, payload);

            outcomes.push({ id, status: receipt.successful ? "ok" : "failed" });
        } catch (error) {
            // `push.send` throws for a provider fault AND for an id that no longer
            // exists (unregistered since the page ran) — both are "not delivered",
            // and the queue's retry budget bounds how long we keep trying.
            outcomes.push({ error: error instanceof Error ? error.message : String(error), id, status: "failed" });
        }
    }

    const failedIds = failedIdsOf(outcomes);
    const sent = outcomes.length - failedIds.length;
    const result = { failed: failedIds.length, outcomes, pruned: 0, sent, total: outcomes.length };

    if (failedIds.length > 0) {
        // A retry job carries only the ids that already failed once, so there is
        // nothing to lose by re-throwing it wholesale: the queue's backoff and,
        // on exhaustion, its dead-letter queue are what bound a device that never
        // recovers (a rotated VAPID key, a revoked token). No delivered recipient
        // is inside this message to be re-sent.
        throw new LunoraError(
            "INTERNAL",
            `@lunora/notify: push retry failed for ${failedIds.length.toString()} of ${outcomes.length.toString()} subscription(s) — throwing so the queue retries and eventually dead-letters them`,
        );
    }

    return { failedIds, nextCursor: undefined, result };
};

/**
 * Run ONE bounded page of an enqueued broadcast job on the consumer side,
 * delivering through the push facade's {@link LunoraPush.broadcastPage} (which
 * reuses the engine's retry + circuit-breaker middleware and prunes gone
 * subscriptions).
 *
 * RETRY / CONTINUATION SEMANTICS:
 *
 * - A job processes exactly ONE bounded page (see `CreateNotifyOptions`'s
 * page-size option, default 250, or `job.filter.limit` when smaller),
 * keyset-paginated on the subscription `id` (see `SubscriptionFilter.after`)
 * — so per-message work is bounded regardless of total audience size.
 * - A page NEVER throws for a partial failure. Throwing discarded the page's
 * `nextCursor`, which is the only way the broadcast advances: one device that
 * fails permanently (a rotated VAPID keypair leaves a stale device answering
 * `403 VapidPkHashMismatch` forever) would then stall the cursor, re-POST
 * every already-delivered recipient on each retry, dead-letter, and leave
 * every LATER page unreached. The page's `nextCursor` and its `failedIds`
 * both come back instead.
 * - The CALLER (the `lunora/queues.ts` consumer) re-enqueues: `filter.after:
 * nextCursor` while more pages remain, and a `retryIds: failedIds` job when
 * any recipient failed. `@lunora/notify` cannot do it itself — it has no
 * `@lunora/queue` dependency (the seam stays structural) and no reference to
 * the producer that enqueued this message. See the consumer example on
 * {@link enqueuePushBroadcast}.
 * - A `retryIds` job redelivers to exactly those ids and DOES throw while any
 * of them still fails, so the queue's backoff/dead-letter bounds it. That
 * message contains no already-delivered recipient, so nothing is re-sent.
 * - Gone subscriptions (404/410, FCM `UNREGISTERED`) are pruned by the page and
 * never appear in `failedIds` — an all-`pruned` page is a success, not a
 * failure, as is an empty page.
 */
const runPushBroadcastPage = async (push: LunoraPush, job: PushBroadcastJob): Promise<PushBroadcastPageOutcome> => {
    if (job.retryIds !== undefined && job.retryIds.length > 0) {
        return runRetryIds(push, job.payload, job.retryIds);
    }

    const page = await push.broadcastPage(job.payload, job.filter);

    return {
        failedIds: failedIdsOf(page.result.outcomes),
        nextCursor: page.nextCursor,
        result: page.result,
    };
};

export { enqueuePushBroadcast, runPushBroadcastPage };
export type { PushBroadcastJob, PushBroadcastPageOutcome, QueueProducerLike };
