/**
 * `dispatchQueueBatch` — routes a delivered `MessageBatch` to the matching
 * `defineQueue` push handler and runs it inside a Lunora queue context. The
 * generated worker `queue()` entry (wired by codegen into `createWorker`) calls
 * this with the project's queue registry. Node-safe so it's unit-testable with
 * plain-object batches.
 *
 * The batch is always instrumented: each message is wrapped so it carries a
 * `run` pinned to its own id (that pin is what makes poison-message isolation
 * work — see {@link resolveAttributedFailure}) and so its final disposition —
 * ack / retry / error — is observed. Delivery semantics are unchanged by the
 * instrumentation: the wrappers call the real `ack`/`retry`/`ackAll`/`retryAll`,
 * and an unattributed handler error is re-thrown so workerd still retries the
 * batch. When an `options.capture` sink is supplied (the codegen worker wires
 * the dev queue catcher's sink), the observed dispositions are turned into
 * records and handed to the sink after the handler runs.
 */
import type { ArgsOf, DispatchRunFunction, FunctionReference, RunFunctionOptions } from "@lunora/dispatch";
// eslint-disable-next-line import/no-extraneous-dependencies -- @lunora/dispatch is a devDependency on purpose: packem inlines it into this bundle, so it is not a published runtime dep
import { getDispatchMessageId, isDeterministicDispatchFailure } from "@lunora/dispatch";
import { LunoraError, toErrorBody } from "@lunora/errors";

import { createQueueRunContext } from "./run-context";
import type { MessageBatchLike, MessageLike, QueueDefinition, QueueMessage, QueueMessageBatch, QueueRetryOptions } from "./types";

/** One declared queue, keyed for batch routing by its stable wrangler name. */
interface QueueRegistryEntry {
    /**
     * The `defineQueue` result (carries the push handler). The body type is
     * erased to `any` here because the registry is heterogeneous — different
     * queues carry different message bodies, and the handler param is
     * contravariant, so a precise `QueueDefinition<Body>` would not be assignable
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
    /** `true` when this failed delivery was the message's last (its retries are exhausted) AND the queue declares a `deadLetterQueue` for it to land in. Stays `false` for a queue with no DLQ, where the broker drops the exhausted message instead — `attempts > maxRetries` with `outcome !== "ack"` is what identifies that case. */
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
     * Optional capture sink. When set, every message's final disposition is
     * turned into a record and handed to this sink after the handler runs.
     * Omitted in production unless queue capture is enabled, so a consumer pays
     * no record-building or sink cost by default. Delivery semantics — including
     * poison-message isolation — do not depend on it.
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
    wrappedBatch: QueueMessageBatch;
}

/**
 * A `ctx.run` pinned to one message. Every call it makes carries two ids:
 * `messageId`, that message's id, so a deterministic dispatch failure comes
 * back attributed to it (see {@link resolveAttributedFailure}) and only that
 * message is taken out of the batch; and `dedupId`, `<messageId>#<n>` with `n`
 * counting THIS message's calls in order, so a redelivery applies each call
 * exactly once.
 *
 * The two must not be the same value. The shard's dedup table is keyed
 * `(identity, mutationId)` with no function path in it, and every
 * server-initiated dispatch shares the `"system:"` identity — so pinning one
 * id onto every call would make `m.run(chargeCustomer)` followed by
 * `m.run(sendReceipt)` collide: the second would return the first's cached
 * result and never execute. The per-call counter is what keeps them distinct.
 *
 * The counter restarts at 1 for every delivery (this closure is built per
 * message per dispatch), which is exactly the property dedup needs: a
 * redelivered handler replays from the start, so its first call reproduces
 * `#1` and dedups against its own first-run result. That assumes the handler
 * issues its `run` calls in a deterministic ORDER — already an at-least-once
 * replay assumption; a handler that branches nondeterministically must pass
 * its own stable `dedupId`.
 *
 * The pin wins over caller-supplied options — the whole point of `message.run`
 * is that a handler never has to know either option exists.
 */
const pinRunToMessage = (run: DispatchRunFunction, messageId: string): DispatchRunFunction => {
    let callCount = 0;

    return <F extends FunctionReference>(function_: F, arguments_?: ArgsOf<F>, options?: RunFunctionOptions): Promise<unknown> => {
        callCount += 1;

        return run(function_, arguments_, { ...options, dedupId: `${messageId}#${String(callCount)}`, messageId });
    };
};

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
 *
 * The wrapper also ADDS `run` — {@link pinRunToMessage} over the run context's
 * dispatcher — which is what a handler calls instead of `ctx.run` to get
 * per-message failure attribution for free.
 */
const wrapMessage = (message: MessageLike, dispositions: Map<MessageLike, QueueMessageOutcome>, run: DispatchRunFunction): QueueMessage => {
    const pinnedRun = pinRunToMessage(run, message.id);

    return new Proxy(message, {
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

            if (property === "run") {
                return pinnedRun;
            }

            return Reflect.get(target, property, target);
        },
    }) as QueueMessage;
};

/**
 * Wrap the batch itself, same rationale as {@link wrapMessage}: `ackAll` /
 * `retryAll` observe the disposition fill and `messages` answers with the
 * WRAPPED messages (so a handler iterating `batch.messages` gets instrumented
 * ones), but `queue` and any other property the real `MessageBatch` carries
 * forward through `Reflect.get` against the real batch.
 */
const wrapBatch = (
    batch: MessageBatchLike,
    wrappedMessages: ReadonlyArray<QueueMessage>,
    fillUndecided: (outcome: QueueMessageOutcome) => void,
): QueueMessageBatch =>
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
    }) as QueueMessageBatch;

/**
 * Build a {@link CaptureHarness} over `batch`. Message and batch objects are
 * wrapped (not mutated) because a real workerd `Message`/`MessageBatch` is a
 * non-extensible host object — reassigning `message.ack` would throw.
 */
const instrumentBatch = (batch: MessageBatchLike, run: DispatchRunFunction): CaptureHarness => {
    const dispositions = new Map<MessageLike, QueueMessageOutcome>();
    const originals = batch.messages;

    const wrappedMessages = originals.map((message) => wrapMessage(message, dispositions, run));

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
 * records — the ONE place an outcome is decided, so nothing downstream has to
 * patch a record after the fact. `attributed`, when set, is the single message a
 * deterministic dispatch failure was scoped to: it was physically acked (see
 * {@link resolveAttributedBatch}) but it FAILED, so it records `error` — that is
 * what tells an operator about it now that it no longer lands in the DLQ — and
 * it is never `deadLettered`, since an acked message is not redelivered at all.
 * For every other message an explicit `ack`/`retry` wins; an undecided message
 * is an implicit `ack` on a clean return, or `error` when the handler threw
 * (workerd retries the whole batch). `deadLettered` flags a non-ack disposition
 * that exhausted the queue's `maxRetries` AND has somewhere to land: with no
 * `deadLetterQueue` configured Cloudflare simply DELETES the exhausted message,
 * so claiming it was dead-lettered sends an operator hunting through a queue
 * that does not exist for a message that no longer exists anywhere.
 */
const buildCaptureRecords = (
    harness: CaptureHarness,
    entry: QueueRegistryEntry,
    queue: string,
    threw: boolean,
    handlerError: unknown,
    attributed: MessageLike | undefined,
): CapturedQueueMessage[] => {
    const errorMessage = threw ? describeThrownError(handlerError) : undefined;
    const maxRetries = typeof entry.definition.maxRetries === "number" ? entry.definition.maxRetries : DEFAULT_MAX_RETRIES;
    // What a message the handler never decided settles as: `error` when the
    // handler threw (the batch is retried by workerd, but the handler signalled
    // failure), else workerd's implicit ack-on-success.
    const undecided: QueueMessageOutcome = threw ? "error" : "ack";
    // A message only reaches a dead-letter queue if the queue declares one.
    const hasDeadLetterQueue = typeof entry.definition.deadLetterQueue === "string" && entry.definition.deadLetterQueue.length > 0;

    return harness.originals.map((message): CapturedQueueMessage => {
        const isAttributed = message === attributed;
        const decided = harness.dispositions.get(message);
        const outcome: QueueMessageOutcome = isAttributed ? "error" : (decided ?? undecided);
        const attempts = typeof message.attempts === "number" ? message.attempts : 1;

        return {
            attempts,
            body: message.body,
            deadLettered: hasDeadLetterQueue && !isAttributed && outcome !== "ack" && attempts > maxRetries,
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
 * When the handler threw a deterministic dispatch failure (400/403/404/422 —
 * see `isDeterministicDispatchFailure`) that is scoped to one message, resolve
 * which message it belongs to — so the caller can ack just that one instead of
 * retrying the whole batch. A call made through `message.run(...)` is scoped
 * automatically ({@link pinRunToMessage}); a bare `ctx.run(fn, args)` is not,
 * unless the handler passes `{ messageId }` itself.
 * Returns `undefined` for every other case: a non-deterministic failure, a
 * deterministic failure with no `messageId` (the handler didn't scope its
 * call — guessing which message it belongs to is unsafe, see plan 338 §1a),
 * an unrecognized `messageId`, or a message the handler already explicitly
 * acked/retried (never override a decision it actually made).
 */
const resolveAttributedFailure = (harness: CaptureHarness, threw: boolean, handlerError: unknown): MessageLike | undefined => {
    if (!threw || !isDeterministicDispatchFailure(handlerError)) {
        return undefined;
    }

    const dispatchMessageId = getDispatchMessageId(handlerError);

    if (dispatchMessageId === undefined) {
        return undefined;
    }

    const message = harness.originals.find((candidate) => candidate.id === dispatchMessageId);

    if (message === undefined || harness.dispositions.has(message)) {
        return undefined;
    }

    return message;
};

/**
 * Ack `attributed` (the one message the failure belongs to) and explicitly
 * retry every OTHER still-undecided message in `harness.originals`. The
 * handler's throw cut its loop short before it necessarily reached every
 * message (see §1a's "adjacent read and call" shape) — a message it never
 * got to is not "successful", so it must be redelivered, not implicitly acked
 * once `dispatchQueueBatch` stops rethrowing. A message the handler already
 * explicitly acked/retried keeps that decision untouched.
 *
 * This settles PHYSICAL delivery only; what each message RECORDS is decided in
 * {@link buildCaptureRecords}, which is why the ack here leaves no disposition
 * behind: the attributed message is acked but records `error`, and that
 * divergence lives in one place rather than being patched onto a built record.
 */
const resolveAttributedBatch = (harness: CaptureHarness, attributed: MessageLike): void => {
    attributed.ack();

    for (const candidate of harness.originals) {
        if (candidate !== attributed && !harness.dispositions.has(candidate)) {
            harness.dispositions.set(candidate, "retry");
            candidate.retry();
        }
    }
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
    // Always instrumented, capture sink or not: the wrapper is what gives each
    // message its pinned `run`, and poison-message isolation is a DELIVERY
    // property — gating it on the dev capture sink left it inert in production,
    // where a single bad message still took its whole batch down with it.
    const harness = instrumentBatch(batch, context.run);
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

    // A failure attributed to one message is that message's problem, not the
    // rest of the batch's: ack JUST it (and retry every other undecided
    // message, so an unprocessed one is redelivered rather than lost — see
    // resolveAttributedBatch) instead of the whole-batch rethrow below. Every
    // other case (see resolveAttributedFailure) stays unattributed and falls
    // through unchanged.
    const attributed = resolveAttributedFailure(harness, threw, handlerError);

    if (attributed !== undefined) {
        resolveAttributedBatch(harness, attributed);

        // Always log the drop. The ack above is terminal — no retry, no DLQ, no
        // redelivery — and the capture record that describes it is only built
        // when `options.capture` is wired, which needs an explicit
        // `LUNORA_QUEUE_CAPTURE=1` or a dev-shaped `WORKER_ENV`. Without this
        // line a production deployment discards the message with no signal
        // anywhere: a rotated admin token silently stops the receipts and
        // nothing says so.
        //
        // This is the ONLY disposition that reaches here: `resolveAttributedFailure`
        // returns a message for a deterministic dispatch failure (400/403/404/422)
        // and nothing else. Retry exhaustion never reaches this line — the broker
        // owns that, and it dead-letters rather than acking — so the message names
        // which of the two happened instead of sending an operator to a DLQ that
        // will never hold it.
        //
        // Routed through `toErrorBody` for the same reason every other
        // error-to-output path in the repo is: this error is rebuilt from a
        // dispatch RESPONSE, and an unparseable body becomes an internal-coded
        // error carrying that body verbatim (see `toDispatchError`'s fallback).
        // Logging the raw value would put an upstream 4xx's response text — a
        // token, a SQL fragment, an internal identifier — into the Workers log.
        // A developer-facing code keeps its message; an internal one is redacted to
        // its code, which together with the message id, queue and export name is
        // what actually locates the failure.
        const { body, status } = toErrorBody(handlerError, { redactedMessage: "internal error" });

        // eslint-disable-next-line no-console -- last-resort operator signal for a dropped message; there is no injected logger on the dispatch path
        console.error(
            `@lunora/queue: dropped message ${attributed.id} on queue "${batch.queue}" (${entry.exportName}) — a dispatch it made failed with a deterministic ${String(status)} (${body.code}: ${body.message}), so it was acked, not retried. Its retries are NOT exhausted and it is not dead-lettered — it will never be redelivered.`,
        );
    }

    // `threw` stays truthful (the handler DID fail, and the records say so);
    // whether the failure propagates is a separate question, and an attributed
    // one does not — the attributed message is acked and every other message
    // has an explicit disposition, so there is nothing left for workerd to
    // redeliver the batch for.
    const rethrow = threw && attributed === undefined;

    if (options.capture !== undefined) {
        // Best-effort by contract: build the records AND run the sink inside one guard
        // so nothing on the capture path can change delivery semantics. If reading a
        // host message or encoding a record throws, a clean batch must still resolve
        // (else workerd re-delivers an already-acked batch) and a failed batch must
        // still re-throw the handler's ORIGINAL value below — never the capture error.
        try {
            await options.capture(buildCaptureRecords(harness, entry, batch.queue, threw, handlerError, attributed));
        } catch (captureError) {
            // Best-effort by contract: never let a capture failure change delivery
            // semantics (see above). But silent-by-contract for the observability
            // feature itself is a DX bug — a stale admin token or shard error would
            // leave the studio Queues panel empty with no diagnostic anywhere — so
            // log it (delivery is unaffected: the handler-error re-throw is below).
            // eslint-disable-next-line no-console -- last-resort diagnostic for a swallowed capture-sink failure; no injected logger on the dispatch path
            console.warn("@lunora/queue: capture sink failed (delivery unaffected):", captureError);
        }
    }

    // Preserve workerd's retry-on-throw: re-throw the handler's original value
    // verbatim after capturing. (`handlerError` is `unknown`, which `only-throw-error`
    // permits, so no disable directive is needed.)
    if (rethrow) {
        throw handlerError;
    }
};

export type { CapturedQueueMessage, QueueCaptureSink, QueueRegistry, QueueRegistryEntry };
export { dispatchQueueBatch };
