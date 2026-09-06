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

import { encodeWire } from "../../../shared/wire-codec";
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
 * Default deadline for one job's dispatch, overridable per dispatcher via
 * {@link HttpDispatcherOptions.timeoutMs}. Deliberately far above
 * `@lunora/dispatch`'s 30s default: that budget is for an inline `ctx.run`
 * inside a handler that is itself serving something, whereas a workpool is
 * precisely where jobs that outlive a request live (an LLM call, an export, a
 * payment round-trip). Truncating those at 30s would turn a working job into a
 * retry loop — and an action's dedup read is not gated, so the retry can run
 * concurrently with the still-in-flight first attempt. 5 minutes still bounds a
 * hung origin well short of the platform killing the whole `queue()`
 * invocation, which is what this dispatcher previously did with no deadline at
 * all.
 */
const DEFAULT_JOB_TIMEOUT_MS = 300_000;

/**
 * The single owner of what this package's producers put in a {@link QueueJob}'s
 * `args` — `enqueue` and `enqueueBatch` both go through here, so the two cannot
 * drift on what a job looks like on the queue.
 *
 * A job's args can hold a `bigint`, a `Date` or bytes, and the queue is a
 * serialising hop: `@lunora/platform-node`'s queue host defaults to
 * `contentType: "json"`, where a `bigint` throws inside `JSON.stringify` before
 * the message is ever recorded and a `Date` silently arrives as an ISO string.
 * A structured-clone (`"v8"`) queue carries both one hop further, only for the
 * dispatcher's own `JSON.stringify` to refuse them identically. Encoding here
 * makes the message body pure JSON on every host, which is also what keeps a
 * dead-lettered job readable.
 *
 * The counterpart decode is the shard's, and it is the ONLY one on this path:
 * `@lunora/do`'s dispatch loop runs `decodeWire(payload.args ?? {})` before the
 * handler. `httpDispatcher` and `/_lunora/scheduler/dispatch` pass `args`
 * through untouched, so nothing between here and there may encode or decode
 * again — `decodeWire` is not idempotent, and a second pass flattens a `Date`
 * to `{}`.
 *
 * `encodeWire` is the identity on pure JSON, so an existing caller's message
 * body is unchanged. Absent args stay absent rather than becoming `{}`: a
 * top-level `undefined` would otherwise encode to the tagged form.
 */
const encodeJobArgs = (args: Record<string, unknown> | undefined): Record<string, unknown> | undefined =>
    args === undefined ? undefined : (encodeWire(args) as Record<string, unknown>);

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
        // `ArgsOf<F>` is the reference's own args object, which TS cannot prove is
        // a `Record<string, unknown>` even though every generated args type is
        // one. Cast at the serialisation boundary rather than loosening the
        // parameter, which is what makes the call site arg-checked at all.
        const job: QueueJob = {
            args: encodeJobArgs(args as Record<string, unknown>),
            functionPath: function_.__lunoraRef,
            shardKey: enqueueOptions.shardKey,
        };
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
            return { body: { args: encodeJobArgs(job.args), functionPath: job.ref.__lunoraRef, shardKey: job.shardKey } satisfies QueueJob };
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
 * through) via `@lunora/dispatch`'s `createDispatchRunner` — which bounds each
 * job with {@link HttpDispatcherOptions.timeoutMs} (default
 * {@link DEFAULT_JOB_TIMEOUT_MS}), so a hung origin no longer holds the whole
 * `queue()` invocation open, and threads the queue message id through for
 * failure attribution. Any dispatch failure throws so the consumer retries the
 * message — including a 2xx carrying a non-empty non-JSON body, which is an
 * intermediary's page rather than a function's return value and therefore no
 * evidence the job ran. An empty 2xx is a normal success (a `void` function).
 *
 * `job.args` is forwarded VERBATIM — `argsAlreadyEncoded`, the runner's opt-out
 * of its own `encodeWire`: {@link encodeJobArgs} already put it in wire form at
 * the producer (it had to, or the queue's own `JSON.stringify` would have
 * refused the message), and the shard's dispatch loop is the single decoder.
 * Encoding again here would leave the handler a tagged array — and a `Date` a
 * `{}`, silently.
 */
const httpDispatcher = (options: HttpDispatcherOptions): QueueDispatch => {
    const run = createDispatchRunner({
        argsAlreadyEncoded: true,
        env: { LUNORA_ADMIN_TOKEN: options.adminToken, LUNORA_ORIGIN_URL: options.originUrl },
        fetchImpl: options.fetchImpl,
        label: "@lunora/scheduler",
    });

    const timeoutMs = options.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

    return async (job: QueueJob, messageId?: string): Promise<void> => {
        // `dedupId: messageId` is what makes a Queues REDELIVERY idempotent: it
        // reaches the shard as the replay-dedup `mutationId`, so a message
        // redelivered after its mutation already committed is applied once
        // instead of charging the customer twice. (The DO-backed path gets this
        // from `SchedulerDO.dispatch` sending `id: record.id`.) Safe to reuse the
        // message id verbatim here — unlike a queue HANDLER, one message
        // dispatches exactly one call, so there is no second call to collide
        // with the first's cached result.
        await run({ __lunoraRef: job.functionPath }, job.args, { dedupId: messageId, messageId, shardKey: job.shardKey, timeoutMs });
    };
};

export { createQueueConsumer, createQueueWorkpool, httpDispatcher };
