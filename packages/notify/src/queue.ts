import { LunoraError } from "@lunora/errors";

import { isGoneError, kindOfId } from "./subscriptions/normalize";
import type { BroadcastOutcome, BroadcastResult, LunoraPush, PushContent, SubscriptionFilter } from "./types";

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
 * The consumer MUST act on BOTH fields: `nextFilter` continues the broadcast and
 * `failedIds` redelivers the recipients this page missed. Acking a message while
 * ignoring either silently drops part of the audience.
 */
interface PushBroadcastPageOutcome {
    /**
     * Subscriptions that failed transiently on this run (gone/pruned devices are
     * NOT here — they are deleted, not retried). Re-enqueue a job carrying these
     * as `retryIds` to redeliver to just them.
     */
    failedIds: string[];

    /**
     * The filter for the CONTINUATION job, or `undefined` when the broadcast is
     * finished (no further pages, or `filter.limit` is spent). Enqueue it
     * verbatim — it carries the next page's cursor AND, when the job set
     * `filter.limit`, the REMAINING budget.
     *
     * This replaces the raw `nextCursor` the runner used to return. Rebuilding
     * the filter at the call site (`{ ...job.filter, after: nextCursor }`)
     * forwarded the ORIGINAL `limit` to every message, so a `limit` documented
     * as an overall audience cap (see {@link SubscriptionFilter.limit}, which
     * `broadcast` honours as one) became a per-message cap and the walk reached
     * the entire audience anyway.
     */
    nextFilter?: SubscriptionFilter;

    /** This page's delivery result. */
    result: BroadcastResult;
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
 * // lunora/notify-fanout.ts — an INTERNAL ACTION, because that is where
 * // `ctx.push` and `ctx.queues` exist.
 * import { internalAction, v } from "./_generated/server";
 * import { enqueuePushBroadcast, runPushBroadcastPage } from "@lunora/notify";
 *
 * export const deliverPage = internalAction
 *     .input({ job: v.any() })
 *     .action(async ({ args: { job }, ctx }) => {
 *         const { failedIds, nextFilter } = await runPushBroadcastPage(ctx.push, job);
 *
 *         if (nextFilter !== undefined) {
 *             // More pages remain — enqueue the continuation. Each message still
 *             // does only ONE bounded page of work. Pass `nextFilter` VERBATIM:
 *             // it carries the cursor and the remaining `limit` budget.
 *             await enqueuePushBroadcast(ctx.queues.push, { filter: nextFilter, payload: job.payload });
 *         }
 *
 *         if (failedIds.length > 0) {
 *             // Redeliver ONLY the recipients that failed — never the whole page.
 *             await enqueuePushBroadcast(ctx.queues.push, { payload: job.payload, retryIds: failedIds });
 *         }
 *     });
 *
 * // lunora/queues.ts — the consumer itself has NO ctx.push / ctx.queues: a
 * // `QueueRunContext` is exactly `{ env, log, run }` (handler signature
 * // `(context, batch)`, in that order). It hands each message to the action above.
 * export const push = defineQueue<PushBroadcastJob>({
 *     handler: async (context, batch) => {
 *         for (const message of batch.messages) {
 *             await message.run(internal.notifyFanout.deliverPage, { job: message.body });
 *             message.ack();
 *         }
 *     },
 * });
 *
 * // in a mutation/action, to start it:
 * await enqueuePushBroadcast(ctx.queues.push, { payload: { body: "…", title: "New drop" } });
 * ```
 */
const enqueuePushBroadcast = (queue: QueueProducerLike, job: Omit<PushBroadcastJob, "type">): Promise<void> =>
    queue.send({ ...job, type: "lunora.push.broadcast" });

/**
 * The filter for the next message of a paged broadcast, or `undefined` when the
 * walk is over.
 *
 * `filter.limit` is an OVERALL audience cap (see its JSDoc; `broadcast` enforces
 * it as one across its internal pages), so the queue path — where each page is a
 * separate message — has to SPEND it: the continuation carries
 * `limit - <reached on this page>`, and a spent budget ends the walk even with
 * pages remaining. Forwarding the original `limit` unchanged let every message
 * reach up to `limit` more devices, so an audience of any size was walked in
 * full.
 */
const continuationFilter = (filter: SubscriptionFilter | undefined, nextCursor: string | undefined, reached: number): SubscriptionFilter | undefined => {
    if (nextCursor === undefined) {
        return undefined;
    }

    if (filter?.limit === undefined) {
        return { ...filter, after: nextCursor };
    }

    const remaining = filter.limit - reached;

    return remaining > 0 ? { ...filter, after: nextCursor, limit: remaining } : undefined;
};

/**
 * The message `push.send` throws for an id with no row left. `deliver` DELETES a
 * gone subscription before `push.send` returns its receipt, so the retry that a
 * gone-as-failed outcome triggers hits exactly this on its next run.
 */
const NO_SUBSCRIPTION_PATTERN = /no registered subscription/u;

/**
 * Redeliver to ONE id and classify what came back.
 *
 * The classification is the whole point: a GONE device settles as `expired`,
 * exactly as the page path reports it — never `failed`. Reported as failed it went
 * straight back into `failedIds`, and the narrower retry the caller then enqueues
 * can only throw `no registered subscription` (the row is already deleted) until
 * the queue dead-letters a device that merely unsubscribed.
 *
 * A receipt carries no `kind`, but the id does — it was minted from the endpoint or
 * the token under a kind-tagged prefix — so `isGoneError` gets the same
 * provider-scoping it has on the broadcast path (`kindOfId` answers `undefined` for
 * an id this package did not mint, which tests every pattern: the documented
 * unknown-provider behaviour).
 *
 * It is only a LABEL. `push.send` above has already routed through `deliver`,
 * which decided pruning from the stored row's real `kind`; nothing here deletes
 * anything, so an id whose prefix is unknown costs at worst an outcome reported
 * `expired` rather than `failed` — never a live subscription.
 */
const retryOne = async (push: LunoraPush, payload: PushContent, id: string): Promise<BroadcastOutcome> => {
    try {
        const receipt = await push.send(id, payload);

        if (receipt.successful) {
            return { id, status: "ok" };
        }

        const error = receipt.errorMessages.join("; ");

        return { error, id, status: isGoneError(error, kindOfId(id)) ? "expired" : "failed" };
    } catch (error) {
        // `push.send` throws for a provider fault AND for an id that no longer
        // exists (unregistered since the page ran). The second is not a failure to
        // retry — there is nothing left to deliver to, on this redelivery or any
        // future one — so it settles as `expired` like any other prune.
        const message = error instanceof Error ? error.message : String(error);

        return { error: message, id, status: NO_SUBSCRIPTION_PATTERN.test(message) ? "expired" : "failed" };
    }
};

/** Redeliver to an explicit set of subscription ids (a previous page's failures). */
const runRetryIds = async (push: LunoraPush, payload: PushContent, ids: ReadonlyArray<string>): Promise<PushBroadcastPageOutcome> => {
    const outcomes: BroadcastOutcome[] = [];

    for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop -- a retry set is a handful of ids; serial keeps the failing provider unpressured
        outcomes.push(await retryOne(push, payload, id));
    }

    const failedIds = failedIdsOf(outcomes);
    const pruned = outcomes.filter((outcome) => outcome.status === "expired").length;
    const sent = outcomes.length - failedIds.length - pruned;
    const result = { failed: failedIds.length, outcomes, pruned, sent, total: outcomes.length };

    if (sent === 0 && failedIds.length > 0) {
        // NOTHING in this message got through, so re-running it wholesale re-sends
        // nothing that already landed: the queue's backoff and, on exhaustion, its
        // dead-letter queue are what bound a device that never recovers (a rotated
        // VAPID key, a revoked token).
        //
        // The throw is deliberately gated on "no recipient recovered". A retry
        // message carries EVERY id it was built with, so throwing after a partial
        // recovery re-POSTs the ids that just succeeded on every redelivery
        // (`a,b,c` → `a,b,c` → `a,b,c`, with only `c` still failing) — a duplicate
        // notification per redelivery for each recovered device. A partly-recovered
        // run therefore RESOLVES and reports the still-failing ids, so the caller
        // enqueues a strictly narrower retry — the same shape a partially-failed
        // page already uses. A device that never recovers never shrinks the set, so
        // it keeps throwing and still dead-letters.
        throw new LunoraError(
            "INTERNAL",
            `@lunora/notify: push retry failed for ${failedIds.length.toString()} of ${outcomes.length.toString()} subscription(s) — throwing so the queue retries and eventually dead-letters them`,
        );
    }

    return { failedIds, nextFilter: undefined, result };
};

/**
 * Run ONE bounded page of an enqueued broadcast job on the consumer side,
 * delivering through the push facade's {@link LunoraPush.broadcastPage} (which
 * reuses the engine's retry + circuit-breaker middleware and prunes gone
 * subscriptions).
 *
 * RETRY / CONTINUATION SEMANTICS:
 *
 * - A job processes exactly ONE bounded page (see `defineNotify`'s
 * `broadcastPageSize`, default 250, or `job.filter.limit` when smaller),
 * keyset-paginated on the subscription `id` (see `SubscriptionFilter.after`)
 * — so per-message work is bounded regardless of total audience size.
 * - A page NEVER throws for a partial failure. Throwing discarded the page's
 * continuation, which is the only way the broadcast advances: one device that
 * fails permanently (a rotated VAPID keypair leaves a stale device answering
 * `403 VapidPkHashMismatch` forever) would then stall the cursor, re-POST
 * every already-delivered recipient on each retry, dead-letter, and leave
 * every LATER page unreached. The page's `nextFilter` and its `failedIds`
 * both come back instead.
 * - The CALLER re-enqueues: `filter: nextFilter` while more pages remain, and a
 * `retryIds: failedIds` job when any recipient failed. `@lunora/notify` cannot
 * do it itself — it has no `@lunora/queue` dependency (the seam stays
 * structural) and no reference to the producer that enqueued this message. See
 * the consumer example on {@link enqueuePushBroadcast}.
 * - `job.filter.limit` is spent across messages, not re-granted to each one:
 * `nextFilter` carries the REMAINING budget and is `undefined` once it runs
 * out, so `limit` caps the whole audience here exactly as it does on
 * {@link LunoraPush.broadcast}.
 * - A `retryIds` job redelivers to exactly those ids and throws only while ALL
 * of them still fail, so the queue's backoff/dead-letter bounds a device that
 * never recovers. Once any recipient recovers the run resolves and reports the
 * rest in `failedIds`, so the narrower retry never re-sends to a device this
 * message already reached. A recipient that turns out to be GONE — a 404/410
 * receipt, or an id whose row no longer exists at all — counts as `pruned` here
 * too, never as a failure: there is nothing left to redeliver to, so retrying it
 * could only burn the queue's budget and dead-letter an unsubscribe.
 * - Gone subscriptions (Web Push 404/410, FCM's `NOT_FOUND` for a dead token) are pruned by the page and
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
        nextFilter: continuationFilter(job.filter, page.nextCursor, page.result.total),
        result: page.result,
    };
};

export { enqueuePushBroadcast, runPushBroadcastPage };
export type { PushBroadcastJob, PushBroadcastPageOutcome, QueueProducerLike };
