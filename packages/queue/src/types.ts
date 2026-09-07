/**
 * Structural types for Cloudflare Queues, the producer surface bound to
 * `ctx.queues`, and the consumer handler a `defineQueue` declares.
 *
 * Everything here is **Node-safe** — the Cloudflare `Queue` / `MessageBatch` /
 * `Message` runtime types are mirrored structurally (`*Like`) so plain-object
 * test doubles satisfy the contract without pulling workerd into a unit test,
 * exactly as `@lunora/workflow` mirrors `Workflow` and `@lunora/d1` mirrors
 * `D1Database`. Codegen and `@lunora/config` import these to derive binding
 * names and reconcile wrangler config from the same definitions the runtime
 * uses.
 */
import type { DispatchLogger, DispatchRunFunction } from "@lunora/dispatch";
import type { MessageBatchLike, MessageLike, MessageSendRequestLike, QueueBindingLike, QueueSendBatchOptions, QueueSendOptions } from "@lunora/platform";

/**
 * The typed producer bound to `ctx.queues.<name>`. Sending is a side effect, so
 * the generated context exposes this only on `MutationCtx` / `ActionCtx` (never
 * the deterministic `QueryCtx`), mirroring `ctx.scheduler` / `ctx.workflows`.
 */
export interface QueueProducer<Body = unknown> {
    /** Enqueue one message. */
    send: (body: Body, options?: QueueSendOptions) => Promise<void>;
    /** Enqueue a batch of messages in one call. */
    sendBatch: (messages: Iterable<MessageSendRequestLike<Body>>, options?: QueueSendBatchOptions) => Promise<void>;
}

/**
 * `ctx.queues` — the map of declared queue export names → typed producers.
 * Codegen narrows this to the exact export names; the package keeps it open so
 * `createQueues` stays schema-agnostic.
 */
export interface Queues {
    [exportName: string]: QueueProducer;
}

/** Options the package-level `createQueues` factory takes. */
export interface LunoraQueuesOptions {
    /** Map of `lunora/queues.ts` export name → Cloudflare `Queue` producer binding. */
    bindings: Record<string, QueueBindingLike>;
}

// ─── Consumer side (the `defineQueue` handler) ──────────────────────────────

// The dispatch primitives (`ctx.run` shape, function refs, the logger) are
// shared with `@lunora/workflow` via `@lunora/dispatch`, re-exported here so
// queue's public surface stays self-describing.
export type { ArgsOf, FunctionReference, DispatchLogger as QueueLogger, DispatchRunFunction as QueueRunFunction, RunFunctionOptions } from "@lunora/dispatch";

/**
 * The context handed to a `defineQueue` handler. Decoupled from `@lunora/server`
 * (like the workflow run context): to touch data, call a Lunora mutation/action
 * via `ctx.run(api.x.y, args)` — the dispatch goes through the same
 * `/_lunora/scheduler/dispatch` path the SchedulerDO and workflows use.
 */
export interface QueueRunContext {
    /** The worker `env` (bindings + vars). */
    readonly env: Record<string, unknown>;
    /** Queue-name-prefixed logger. */
    readonly log: DispatchLogger;

    /**
     * Invoke a Lunora function (query/mutation/action) by reference.
     *
     * Batch-unaware: a failure it throws is attributed to nothing, so a
     * deterministic failure retries the whole batch. Inside the `batch.messages`
     * loop, prefer {@link QueueMessage.run}, which pins the call to its message.
     */
    readonly run: DispatchRunFunction;
}

/**
 * One delivered message as the push handler sees it: the Cloudflare `Message`
 * plus `run` — a {@link QueueRunContext.run} pinned to THIS message.
 *
 * Prefer `message.run(api.x.y, args)` over `ctx.run(...)` inside the batch
 * loop. The pin is what lets the dispatcher attribute a deterministic dispatch
 * failure (400/403/404/422) to the one message that caused it: that message is
 * acked and every other one is retried, instead of the whole batch being
 * re-delivered because of a single poison message. A plain `ctx.run` call
 * carries no message id, so its failure stays unattributed and the whole batch
 * retries.
 */
export interface QueueMessage<Body = unknown> extends MessageLike<Body> {
    /** {@link QueueRunContext.run}, pinned to this message for failure attribution. */
    readonly run: DispatchRunFunction;
}

/** The delivered batch as the push handler sees it — {@link QueueMessage}s rather than bare `Message`s. */
export interface QueueMessageBatch<Body = unknown> extends Omit<MessageBatchLike<Body>, "messages"> {
    readonly messages: ReadonlyArray<QueueMessage<Body>>;
}

/** Whether a declared queue is consumed by this worker (push) or polled externally (pull). */
export type QueueConsumerMode = "pull" | "push";

/** The handler body run for each delivered batch (push consumers only). */
export type QueueHandler<Body = unknown> = (context: QueueRunContext, batch: QueueMessageBatch<Body>) => Promise<void> | void;

/** Push-consumer batch/retry tuning, mirrored onto the wrangler `queues.consumers[]` entry. */
export interface QueueConsumerTuning {
    /** Name of the dead-letter queue messages land in after `maxRetries`. */
    deadLetterQueue?: string;
    /** Max messages per batch (1–100, Cloudflare default 10). */
    maxBatchSize?: number;
    /** Max seconds to wait before delivering a partial batch (0–60, default 5). */
    maxBatchTimeout?: number;
    /** Retries **after** the initial delivery, before a message is dropped / dead-lettered. Default 3, so up to 4 deliveries in total. */
    maxRetries?: number;
    /** Delay in seconds before a failed batch is retried. */
    retryDelay?: number;
}

/** The config object passed to `defineQueue`. */
export interface QueueConfig<Body = unknown> extends QueueConsumerTuning {
    /**
     * The push-consumer body. Required for `mode: "push"` (the default); omit it
     * for `mode: "pull"`, where an external worker polls the queue over HTTP.
     */
    handler?: QueueHandler<Body>;
    /** How this queue is consumed. Defaults to `"push"`. */
    mode?: QueueConsumerMode;

    /**
     * Stable wrangler queue name (`queues.producers[].queue`). Defaults to the
     * kebab-cased export name (`emailQueue` → `email-queue`).
     */
    name?: string;
}

/** The branded result of `defineQueue`, discovered by codegen + config. */
export interface QueueDefinition<Body = unknown> extends QueueConfig<Body> {
    /**
     * Phantom carrier for the message body type, so codegen can type the
     * generated `ctx.queues.<name>` producer as `QueueProducer<Body>` from
     * `typeof <export>`. Never assigned at runtime (type-only).
     */
    readonly __lunoraBody?: Body;
    /** Runtime brand identifying a `defineQueue` result. */
    isLunoraQueue: true;
}

/** Wiring info for one declared queue, emitted by codegen into the generated shard/handler. */
export interface QueueBindingSpec {
    /** The Cloudflare `Queue` producer binding name, e.g. `QUEUE_EMAIL`. */
    binding: string;
    /** The `lunora/queues.ts` export name, e.g. `emailQueue`. */
    exportName: string;
    /** The stable wrangler queue name, e.g. `email-queue`. */
    name: string;
}

export {
    type MessageBatchLike,
    type MessageLike,
    type MessageSendRequestLike,
    type QueueBindingLike,
    type QueueContentType,
    type QueueRetryOptions,
    type QueueSendBatchOptions,
    type QueueSendOptions,
} from "@lunora/platform";
