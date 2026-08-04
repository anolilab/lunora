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
import type { MessageBatchLike, MessageSendRequestLike, QueueBindingLike, QueueSendBatchOptions, QueueSendOptions } from "@lunora/platform";

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
