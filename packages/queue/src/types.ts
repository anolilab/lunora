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

/** How a queue message body is serialized on the wire (Cloudflare default `"json"`). */
export type QueueContentType = "bytes" | "json" | "text" | "v8";

/** Options for a single `producer.send(body, options?)`. */
export interface QueueSendOptions {
    /** Wire serialization for this message (defaults to the queue's content type). */
    contentType?: QueueContentType;
    /** Per-message delivery delay in seconds (0–43200, i.e. up to 12 hours). */
    delaySeconds?: number;
}

/** Options for a `producer.sendBatch(messages, options?)`. */
export interface QueueSendBatchOptions {
    /** Delivery delay applied to the whole batch, in seconds. */
    delaySeconds?: number;
}

/** One entry in a `sendBatch` call — a body plus optional per-message overrides. */
export interface MessageSendRequestLike<Body = unknown> {
    body: Body;
    contentType?: QueueContentType;
    delaySeconds?: number;
}

/**
 * Minimal structural projection of workers-types' `Queue&lt;Body>` (the producer
 * binding). The real binding's `send`/`sendBatch` resolve to a metadata object;
 * we widen the return to `Promise&lt;unknown>` so a plain-object fake satisfies it.
 */
export interface QueueBindingLike<Body = unknown> {
    send: (message: Body, options?: QueueSendOptions) => Promise<unknown>;
    sendBatch: (messages: Iterable<MessageSendRequestLike<Body>>, options?: QueueSendBatchOptions) => Promise<unknown>;
}

/** Options for retrying a message / batch (`message.retry({ delaySeconds })`). */
export interface QueueRetryOptions {
    delaySeconds?: number;
}

/** Structural mirror of workers-types' `Message&lt;Body>` (one delivered message). */
export interface MessageLike<Body = unknown> {
    /** Acknowledge this message so it is not redelivered. */
    ack: () => void;
    readonly attempts: number;
    readonly body: Body;
    readonly id: string;
    /** Explicitly retry this message (optionally after a delay). */
    retry: (options?: QueueRetryOptions) => void;
    readonly timestamp: Date;
}

/** Structural mirror of workers-types' `MessageBatch&lt;Body>` handed to a consumer. */
export interface MessageBatchLike<Body = unknown> {
    /** Acknowledge every message in the batch. */
    ackAll: () => void;
    readonly messages: ReadonlyArray<MessageLike<Body>>;
    /** The queue name this batch was delivered from (`batch.queue`), used to route. */
    readonly queue: string;
    /** Retry every message in the batch (optionally after a delay). */
    retryAll: (options?: QueueRetryOptions) => void;
}

/**
 * The typed producer bound to `ctx.queues.&lt;name>`. Sending is a side effect, so
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
    /** Invoke a Lunora function (query/mutation/action) by reference. */
    readonly run: DispatchRunFunction;
}

/** Whether a declared queue is consumed by this worker (push) or polled externally (pull). */
export type QueueConsumerMode = "pull" | "push";

/** The handler body run for each delivered batch (push consumers only). */
export type QueueHandler<Body = unknown> = (context: QueueRunContext, batch: MessageBatchLike<Body>) => Promise<void> | void;

/** Push-consumer batch/retry tuning, mirrored onto the wrangler `queues.consumers[]` entry. */
export interface QueueConsumerTuning {
    /** Name of the dead-letter queue messages land in after `maxRetries`. */
    deadLetterQueue?: string;
    /** Max messages per batch (1–100, Cloudflare default 10). */
    maxBatchSize?: number;
    /** Max seconds to wait before delivering a partial batch (0–60, default 5). */
    maxBatchTimeout?: number;
    /** Max delivery attempts before a message is dropped / dead-lettered (default 3). */
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
     * generated `ctx.queues.&lt;name>` producer as `QueueProducer&lt;Body>` from
     * `typeof &lt;export>`. Never assigned at runtime (type-only).
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
