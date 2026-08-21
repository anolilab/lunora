/**
 * Cloudflare Queues-backed workpool — the lighter alternative to the
 * SchedulerDO-based `createWorkpool`.
 *
 * Use this when you just want to rate-limit fire-and-forget background work:
 * Queues natively provide concurrency capping, retries, backoff, and
 * dead-lettering, all configured on the consumer in `wrangler.jsonc`
 * (`max_concurrency` / `max_retries` / `retry_delay` / `dead_letter_queue`).
 * There is NO hard concurrency cap, per-job cancellation, or per-job status here
 * — reach for `createWorkpool` when you need those (it serializes through a
 * single Durable Object to provide them).
 *
 * The pieces: `createQueueWorkpool` is the producer (`enqueue(fn, args)` puts a
 * {@link QueueJob} on the queue); `createQueueConsumer` wraps your `queue()`
 * handler (it dispatches each message and uses the message's native `ack()` /
 * `retry()` so failures ride Queues' retry + dead-letter machinery); and
 * `httpDispatcher` is the default dispatcher (dispatches each job to the
 * Worker's `/_lunora/scheduler/dispatch` endpoint via `@lunora/dispatch`'s
 * `createDispatchRunner`, authenticated with the admin bearer).
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { createDispatchRunner } from "@lunora/dispatch";
import { LunoraError } from "@lunora/errors";

import type {
    ArgsOf,
    FunctionReference,
    HttpDispatcherOptions,
    MessageBatchLike,
    QueueConsumerOptions,
    QueueDispatch,
    QueueEnqueueOptions,
    QueueJob,
    QueueSendOptionsLike,
    QueueWorkpool,
    QueueWorkpoolOptions,
} from "./types";

/**
 * Cloudflare Queues ceiling on one `sendBatch`: 100 messages. The byte caps
 * alongside it (256 KB per batch, 128 KB per message) are left to the platform,
 * which rejects them clearly — measuring them here means serializing every body
 * a second time on the send path. Mirrored in `@lunora/queue` and
 * `@lunora/scheduler`; no dependency edge between them.
 */
const MAX_QUEUE_BATCH = 100;

/**
 * Build a Queues producer that enqueues Lunora function dispatches. Concurrency
 * and retry policy live on the consumer's `wrangler.jsonc` config, not here.
 */
const createQueueWorkpool = (options: QueueWorkpoolOptions): QueueWorkpool => {
    // Defensive runtime guard: required by the type, but JS callers can omit it.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    if (!options.queue) {
        throw new LunoraError("INTERNAL", "@lunora/scheduler: `queue` (a Cloudflare Queue binding) is required");
    }

    const enqueue = async <F extends FunctionReference>(function_: F, args: ArgsOf<F>, enqueueOptions: QueueEnqueueOptions = {}): Promise<void> => {
        const job: QueueJob = { args, functionPath: function_.__lunoraRef, shardKey: enqueueOptions.shardKey };
        const sendOptions = enqueueOptions.delaySeconds === undefined ? undefined : { delaySeconds: enqueueOptions.delaySeconds };

        await options.queue.send(job, sendOptions);
    };

    const enqueueBatch = async (
        jobs: ReadonlyArray<{ args?: Record<string, unknown>; ref: FunctionReference; shardKey?: string }>,
        sendOptions?: QueueSendOptionsLike,
    ): Promise<void> => {
        if (jobs.length > MAX_QUEUE_BATCH) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/scheduler: enqueueBatch exceeds ${String(MAX_QUEUE_BATCH)} (got ${String(jobs.length)}) — split across calls`,
            );
        }

        const messages = jobs.map((job) => {
            return { body: { args: job.args, functionPath: job.ref.__lunoraRef, shardKey: job.shardKey } satisfies QueueJob };
        });

        await options.queue.sendBatch(messages, sendOptions);
    };

    return { enqueue, enqueueBatch };
};

/** Validate a decoded queue message body is a dispatchable {@link QueueJob}. */
const isQueueJob = (value: unknown): value is QueueJob =>
    typeof value === "object" && value !== null && typeof (value as { functionPath?: unknown }).functionPath === "string";

/**
 * Wrap a {@link QueueDispatch} into a Cloudflare `queue()` consumer handler.
 *
 * Each message is dispatched independently (concurrently across the batch). On
 * success the message is `ack()`-ed; on any failure — a thrown dispatcher or a
 * structurally-invalid body — it is `retry()`-ed, so Queues' own `max_retries`
 * + `dead_letter_queue` settings decide when to give up. Nothing is silently
 * dropped: a permanently-bad message rides retries into the dead-letter queue
 * where you can inspect it.
 */
const createQueueConsumer =
    (options: QueueConsumerOptions): ((batch: MessageBatchLike) => Promise<void>) =>
    async (batch: MessageBatchLike): Promise<void> => {
        await Promise.all(
            batch.messages.map(async (message) => {
                try {
                    if (!isQueueJob(message.body)) {
                        throw new LunoraError("INTERNAL", "@lunora/scheduler: queue message body is not a QueueJob (missing functionPath)");
                    }

                    await options.dispatch(message.body, message.id);
                    message.ack();
                } catch {
                    // Hand off to Queues' retry/dead-letter machinery.
                    message.retry();
                }
            }),
        );
    };

/**
 * Default {@link QueueDispatch}: dispatch each job to the Worker's
 * `/_lunora/scheduler/dispatch` endpoint (the same path SchedulerDO dispatches
 * through) via `@lunora/dispatch`'s `createDispatchRunner` — which bounds the
 * call with the runner's default timeout (a hung origin no longer holds the
 * whole `queue()` invocation open) and threads the queue message id through for
 * failure attribution. Any dispatch failure throws so the consumer retries the
 * message.
 */
const httpDispatcher = (options: HttpDispatcherOptions): QueueDispatch => {
    const run = createDispatchRunner({
        env: { LUNORA_ADMIN_TOKEN: options.adminToken, LUNORA_ORIGIN_URL: options.originUrl },
        fetchImpl: options.fetchImpl,
        label: "@lunora/scheduler",
    });

    return async (job: QueueJob, messageId?: string): Promise<void> => {
        await run({ __lunoraRef: job.functionPath }, job.args, { messageId, shardKey: job.shardKey });
    };
};

export { createQueueConsumer, createQueueWorkpool, httpDispatcher };
