/**
 * `dispatchQueueBatch` — routes a delivered `MessageBatch` to the matching
 * `defineQueue` push handler and runs it inside a Lunora queue context. The
 * generated worker `queue()` entry (wired by codegen into `createWorker`) calls
 * this with the project's queue registry. Node-safe so it's unit-testable with
 * plain-object batches.
 *
 * When an `options.capture` sink is supplied (the codegen worker wires the dev
 * queue catcher's sink), the batch is instrumented so the final disposition of
 * every message — ack / retry / error — is recorded and handed to the sink after
 * the handler runs, WITHOUT changing delivery semantics: the wrappers call the
 * real `ack`/`retry`/`ackAll`/`retryAll`, and a thrown handler error is re-thrown
 * so workerd still retries the batch.
 */
import { LunoraError } from "@lunora/errors";

import { createQueueRunContext } from "./run-context";
import type { MessageBatchLike, MessageLike, QueueDefinition, QueueRetryOptions } from "./types";

/** One declared queue, keyed for batch routing by its stable wrangler name. */
interface QueueRegistryEntry {
    /**
     * The `defineQueue` result (carries the push handler). The body type is
     * erased to `any` here because the registry is heterogeneous — different
     * queues carry different message bodies, and the handler param is
     * contravariant, so a precise `QueueDefinition&lt;Body>` would not be assignable
     * to a shared `unknown`-bodied slot. Runtime dispatch passes the delivered
     * batch straight through, so the erasure is type-only.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry; see doc above
    definition: QueueDefinition<any>;
    /** The `lunora/queues.ts` export name, for log correlation. */
    exportName: string;
}

/** Map of stable wrangler queue name → registry entry, built by codegen. */
type QueueRegistry = Record<string, QueueRegistryEntry>;

/** The disposition a consumer left one message in for a single delivery attempt. */
type QueueMessageOutcome = "ack" | "error" | "retry";

/**
 * One consumed message as captured by {@link dispatchQueueBatch} and handed to an
 * {@link QueueCaptureSink}. Structurally matches `@lunora/do`'s
 * `RecordQueueMessageInput` (the reserved `recordQueueMessage` admin RPC payload);
 * the two packages share only this contract, so keep them in sync by hand.
 */
interface CapturedQueueMessage {
    /** Delivery attempt number for this message (`message.attempts`). */
    attempts: number;
    /** The message body (JSON-encoded + capped by the catcher). */
    body: unknown;
    /** `true` when this failed delivery was the message's last (its retries are exhausted — the broker dead-letters it). */
    deadLettered: boolean;
    /** Handler error message when `outcome` is `error`; absent otherwise. */
    error?: string;
    /** The `lunora/queues.ts` export name that consumed it. */
    exportName: string;
    /** The delivered message id (`message.id`). */
    messageId: string;
    /** How the handler disposed of the message this attempt. */
    outcome: QueueMessageOutcome;
    /** The stable wrangler queue name the batch was delivered from (`batch.queue`). */
    queue: string;
    /** Original message timestamp in epoch-ms (`message.timestamp`). */
    timestamp: number;
}

/**
 * Persists a batch of consumed messages. The codegen worker wires this to POST the
 * batch to the root shard's `recordQueueMessage` admin RPC (the dev queue catcher).
 * Best-effort by contract: {@link dispatchQueueBatch} swallows a rejection so a
 * capture failure never changes delivery semantics.
 */
type QueueCaptureSink = (messages: CapturedQueueMessage[]) => Promise<void> | void;

interface DispatchOptions {
    /**
     * Optional capture sink. When set, the batch is instrumented and every
     * message's final disposition is recorded and handed to this sink after the
     * handler runs. Omitted in production unless queue capture is enabled, so a
     * consumer pays no instrumentation cost by default.
     */
    capture?: QueueCaptureSink;
    /** Worker `env`, forwarded to the queue run context. */
    env: Record<string, unknown>;
    /** Injectable fetch for the `ctx.run` dispatcher (tests). */
    fetchImpl?: typeof fetch;
}

/** Cloudflare Queues' default `max_retries` (retries after the initial delivery; total deliveries = 1 + max_retries). */
const DEFAULT_MAX_RETRIES = 3;

/** Coerce a `Message.timestamp` (a `Date`, or a number/string in test doubles) to epoch-ms. */
const timestampToMs = (value: unknown): number => {
    if (value instanceof Date) {
        return value.getTime();
    }

    const asNumber = typeof value === "number" ? value : Number(value);

    return Number.isFinite(asNumber) ? asNumber : 0;
};

/**
 * A batch wrapped so each message's `ack`/`retry` (and the batch-wide
 * `ackAll`/`retryAll`) records its disposition before delegating to the real
 * method. Returned alongside the disposition map and the original messages so the
 * caller can compute per-message outcomes once the handler settles.
 */
interface CaptureHarness {
    dispositions: Map<MessageLike, QueueMessageOutcome>;
    originals: ReadonlyArray<MessageLike>;
    wrappedBatch: MessageBatchLike;
}

/**
 * Wrap one message so `ack`/`retry` record their disposition (keyed by the
 * REAL, un-proxied `message` — the same key {@link buildCaptureRecords} looks
 * up against `harness.originals`) before delegating to the real method. Every
 * OTHER property — `attempts`/`body`/`id`/`timestamp`, and anything a real
 * workerd `Message` carries beyond the four the structural `MessageLike` type
 * declares — forwards through `Reflect.get`, so an undeclared property reads
 * its real value under capture exactly like it would with capture off.
 *
 * A `Proxy` over `message` (not a rebuilt object literal, and not
 * `Object.create(message)`) is required for that "anything else" case: a
 * hand-picked property list is exactly the bug this fixes, and
 * `Object.create` can't fix the same problem because an inherited accessor
 * looked up through a prototype chain still runs with the WRAPPER as `this`.
 * The `get` trap sidesteps that by pinning the receiver to `message` itself —
 * a workerd `Message` is a host object, and an accessor invoked with a
 * non-genuine `this` can throw ("illegal invocation") — so every forwarded
 * read runs against the real instance, never the proxy.
 */
const wrapMessage = (message: MessageLike, dispositions: Map<MessageLike, QueueMessageOutcome>): MessageLike =>
    new Proxy(message, {
        get: (target, property): unknown => {
            if (property === "ack") {
                return (): void => {
                    dispositions.set(target, "ack");
                    target.ack();
                };
            }

            if (property === "retry") {
                return (options?: QueueRetryOptions): void => {
                    dispositions.set(target, "retry");
                    target.retry(options);
                };
            }

            return Reflect.get(target, property, target);
        },
    });

/**
 * Wrap the batch itself, same rationale as {@link wrapMessage}: `ackAll` /
 * `retryAll` observe the disposition fill and `messages` answers with the
 * WRAPPED messages (so a handler iterating `batch.messages` gets instrumented
 * ones), but `queue` and any other property the real `MessageBatch` carries
 * forward through `Reflect.get` against the real batch.
 */
const wrapBatch = (
    batch: MessageBatchLike,
    wrappedMessages: ReadonlyArray<MessageLike>,
    fillUndecided: (outcome: QueueMessageOutcome) => void,
): MessageBatchLike =>
    new Proxy(batch, {
        get: (target, property): unknown => {
            if (property === "ackAll") {
                return (): void => {
                    fillUndecided("ack");
                    target.ackAll();
                };
            }

            if (property === "retryAll") {
                return (options?: QueueRetryOptions): void => {
                    fillUndecided("retry");
                    target.retryAll(options);
                };
            }

            if (property === "messages") {
                return wrappedMessages;
            }

            return Reflect.get(target, property, target);
        },
    });

/**
 * Build a {@link CaptureHarness} over `batch`. Message and batch objects are
 * wrapped (not mutated) because a real workerd `Message`/`MessageBatch` is a
 * non-extensible host object — reassigning `message.ack` would throw.
 */
const instrumentBatch = (batch: MessageBatchLike): CaptureHarness => {
    const dispositions = new Map<MessageLike, QueueMessageOutcome>();
    const originals = batch.messages;

    const wrappedMessages = originals.map((message) => wrapMessage(message, dispositions));

    /** Fill the disposition for every message the handler didn't explicitly decide. */
    const fillUndecided = (outcome: QueueMessageOutcome): void => {
        for (const message of originals) {
            if (!dispositions.has(message)) {
                dispositions.set(message, outcome);
            }
        }
    };

    const wrappedBatch = wrapBatch(batch, wrappedMessages, fillUndecided);

    return { dispositions, originals, wrappedBatch };
};

/** Best-effort human-readable message for a thrown value that may not be an `Error`. */
const describeThrownError = (handlerError: unknown): string => {
    if (handlerError instanceof Error) {
        return handlerError.message;
    }

    if (typeof handlerError === "string") {
        return handlerError;
    }

    if (handlerError !== null && typeof handlerError === "object") {
        try {
            return JSON.stringify(handlerError);
        } catch {
            // A cyclic (or BigInt-bearing) thrown object can't be JSON-encoded, and
            // its default `String()` is a useless `[object Object]`. Return a fixed
            // diagnostic rather than letting the describe step throw — that throw
            // would replace the handler's original error and skip the capture
            // epilogue below.
            return "[unserializable thrown value]";
        }
    }

    return String(handlerError);
};

/**
 * Resolve each message's final {@link QueueMessageOutcome} and build the capture
 * records. An explicit `ack`/`retry` wins; an undecided message is an implicit
 * `ack` on a clean return, or `error` when the handler threw (workerd retries the
 * whole batch). `deadLettered` flags a non-ack disposition that exhausted the
 * queue's `maxRetries`.
 */
const buildCaptureRecords = (
    harness: CaptureHarness,
    entry: QueueRegistryEntry,
    queue: string,
    threw: boolean,
    handlerError: unknown,
): CapturedQueueMessage[] => {
    const errorMessage = threw ? describeThrownError(handlerError) : undefined;
    const maxRetries = typeof entry.definition.maxRetries === "number" ? entry.definition.maxRetries : DEFAULT_MAX_RETRIES;

    return harness.originals.map((message): CapturedQueueMessage => {
        const decided = harness.dispositions.get(message);
        // Undecided + throw ⇒ the batch is retried by workerd but the handler
        // signalled failure, so surface it as `error`; undecided + clean return
        // ⇒ workerd's implicit ack-on-success.
        const outcome: QueueMessageOutcome = decided ?? (threw ? "error" : "ack");
        const attempts = typeof message.attempts === "number" ? message.attempts : 1;

        return {
            attempts,
            body: message.body,
            deadLettered: outcome !== "ack" && attempts > maxRetries,
            error: outcome === "error" ? errorMessage : undefined,
            exportName: entry.exportName,
            messageId: message.id,
            outcome,
            queue,
            timestamp: timestampToMs(message.timestamp),
        };
    });
};

/**
 * Look up the handler for `batch.queue` and invoke it with a fresh
 * `QueueRunContext`. Throws a directed error when no push handler is registered
 * for the delivered queue (a misconfiguration — the consumer was declared
 * `pull`, or the queue name drifted from the `defineQueue` export).
 */
const dispatchQueueBatch = async (batch: MessageBatchLike, registry: QueueRegistry, options: DispatchOptions): Promise<void> => {
    // Guard the lookup with `Object.hasOwn`: the registry is an ordinary object
    // literal emitted by codegen, so a batch delivered from an undeclared queue
    // named `constructor` / `toString` / `hasOwnProperty` (all valid wrangler
    // queue names) would otherwise resolve an inherited Object.prototype member
    // instead of `undefined` and skip the directed error below (mirrors the
    // null-prototype/`Object.hasOwn` hardening on the producer map in create-queues.ts).
    const entry = Object.hasOwn(registry, batch.queue) ? registry[batch.queue] : undefined;

    if (entry === undefined) {
        const known = Object.keys(registry);
        const suffix = known.length === 0 ? "no push queues are declared" : `known push queues: ${known.join(", ")}`;

        throw new LunoraError("INTERNAL", `@lunora/queue: received a batch for queue "${batch.queue}" but no push handler is registered (${suffix})`);
    }

    const { handler } = entry.definition;

    if (typeof handler !== "function") {
        throw new TypeError(`@lunora/queue: queue "${batch.queue}" (${entry.exportName}) has no push handler — it is declared as a pull consumer`);
    }

    const context = createQueueRunContext({ env: options.env, exportName: entry.exportName, fetchImpl: options.fetchImpl });

    // Fast path: no capture sink ⇒ no instrumentation, unchanged behavior.
    if (options.capture === undefined) {
        await handler(context, batch);

        return;
    }

    const harness = instrumentBatch(batch);
    // A separate flag, not `handlerError !== undefined`: a handler can throw a
    // falsy/undefined value (`throw undefined`, `Promise.reject()`), which must
    // still record `error` and re-throw — testing the captured value would
    // mis-read those as a clean return.
    let threw = false;
    let handlerError: unknown;

    try {
        await handler(context, harness.wrappedBatch);
    } catch (error) {
        threw = true;
        handlerError = error;
    }

    // Best-effort by contract: build the records AND run the sink inside one guard
    // so nothing on the capture path can change delivery semantics. If reading a
    // host message or encoding a record throws, a clean batch must still resolve
    // (else workerd re-delivers an already-acked batch) and a failed batch must
    // still re-throw the handler's ORIGINAL value below — never the capture error.
    try {
        const records = buildCaptureRecords(harness, entry, batch.queue, threw, handlerError);

        await options.capture(records);
    } catch (captureError) {
        // Best-effort by contract: never let a capture failure change delivery
        // semantics (see above). But silent-by-contract for the observability
        // feature itself is a DX bug — a stale admin token or shard error would
        // leave the studio Queues panel empty with no diagnostic anywhere — so
        // log it (delivery is unaffected: the handler-error re-throw is below).
        // eslint-disable-next-line no-console -- last-resort diagnostic for a swallowed capture-sink failure; no injected logger on the dispatch path
        console.warn("@lunora/queue: capture sink failed (delivery unaffected):", captureError);
    }

    // Preserve workerd's retry-on-throw: re-throw the handler's original value
    // verbatim after capturing. (`handlerError` is `unknown`, which `only-throw-error`
    // permits, so no disable directive is needed.)
    if (threw) {
        throw handlerError;
    }
};

export type { CapturedQueueMessage, QueueCaptureSink, QueueRegistry, QueueRegistryEntry };
export { dispatchQueueBatch };
