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
 * `httpDispatcher` is the default dispatcher (POSTs each job to the Worker's
 * `/_lunora/scheduler/dispatch` endpoint, authenticated with the admin bearer).
 */
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
 * Cloudflare Queues hard ceiling on a single `sendBatch` call: 100 messages
 * (also capped at 1 MB total / 256 KB per message — see the Cloudflare Queues
 * limits documentation). Mirrors `@lunora/queue`'s `create-queues.ts` guard of
 * the same name and value; duplicated rather than shared because the two
 * packages have no dependency edge and a `shared/` file for one integer is
 * overkill.
 */
const MAX_QUEUE_BATCH = 100;

/** Strip trailing slashes from an origin so the dispatch path joins cleanly. */
const trimTrailingSlashes = (value: string): string => {
    let end = value.length;

    while (end > 0 && value[end - 1] === "/") {
        end -= 1;
    }

    return value.slice(0, end);
};

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
                "INTERNAL",
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

                    await options.dispatch(message.body);
                    message.ack();
                } catch {
                    // Hand off to Queues' retry/dead-letter machinery.
                    message.retry();
                }
            }),
        );
    };

/**
 * Default {@link QueueDispatch}: POST each job to the Worker's
 * `/_lunora/scheduler/dispatch` endpoint (the same path SchedulerDO dispatches
 * through), authenticated with the admin bearer. A non-2xx response throws so
 * the consumer retries the message.
 */
const httpDispatcher = (options: HttpDispatcherOptions): QueueDispatch => {
    const fetchImpl = options.fetchImpl ?? (globalThis as unknown as { fetch: typeof fetch }).fetch;

    if (typeof fetchImpl !== "function") {
        throw new TypeError("@lunora/scheduler: no fetch implementation available — pass fetchImpl or run on a platform with global fetch");
    }

    const url = `${trimTrailingSlashes(options.originUrl)}/_lunora/scheduler/dispatch`;

    return async (job: QueueJob): Promise<void> => {
        const response = await fetchImpl(url, {
            body: JSON.stringify({ args: job.args ?? {}, functionPath: job.functionPath, shardKey: job.shardKey }),
            headers: { authorization: `Bearer ${options.adminToken}`, "content-type": "application/json" },
            method: "POST",
        });

        if (!response.ok) {
            throw new LunoraError("INTERNAL", `@lunora/scheduler: queue dispatch failed (${response.status.toString()}): ${await response.text()}`);
        }
    };
};

export { createQueueConsumer, createQueueWorkpool, httpDispatcher };
