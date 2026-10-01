/**
 * `ctx.queues` — a thin, typed pass-through over the Cloudflare `Queue` producer
 * bindings. Node-safe (structural binding types), so it's exercised by unit
 * tests with plain-object doubles.
 */
import { LunoraError } from "@lunora/errors";

import { hasRequeueKey, REQUEUED_KEY } from "./requeue-envelope";
import type { LunoraQueuesOptions, MessageSendRequestLike, QueueBindingLike, QueueProducer, Queues, QueueSendBatchOptions, QueueSendOptions } from "./types";

/**
 * Cloudflare Queues ceiling on one `sendBatch`: 100 messages. The byte caps
 * alongside it (256 KB per batch, 128 KB per message) are left to the platform,
 * which rejects them clearly — measuring them here means serializing every body
 * a second time on the send path. Mirrored in `@lunora/queue` and
 * `@lunora/scheduler`; no dependency edge between them.
 */
const MAX_QUEUE_BATCH = 100;

/**
 * Cloudflare Queues ceiling on a per-message (or per-batch) delivery delay: 12
 * hours. Mirrored by `@lunora/platform-node`'s host, which clamps to the same
 * number — so without this check the same `delaySeconds: 64_800` fires 6 hours
 * early on Node and is rejected by the platform on Cloudflare, from inside the
 * mutation, with an error that names neither the limit nor the option.
 */
const MAX_DELAY_SECONDS = 43_200;

/** Refuse a delay past the platform ceiling, naming the limit and the option. */
const assertDelay = (delaySeconds: number | undefined, where: string): void => {
    if (delaySeconds !== undefined && delaySeconds > MAX_DELAY_SECONDS) {
        // `VALIDATION_ERROR` (400) for the same reason the batch-size guard uses
        // it: the caller passed a value the platform cannot accept, which is not
        // a server fault.
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/queue: ${where} delaySeconds is ${String(delaySeconds)}, over the Cloudflare Queues ceiling of ${String(MAX_DELAY_SECONDS)} (12 hours) — use @lunora/scheduler for longer schedules`,
        );
    }
};

/**
 * Refuse a body carrying the key the consumer's re-enqueued copies use. The
 * consumer only unwraps a copy whose MAC verifies, so this is not what keeps a
 * forged one out; it keeps an app from shipping a body the consumer would read
 * differently from what the app sent.
 */
const assertNoRequeueKey = (body: unknown, where: string): void => {
    if (hasRequeueKey(body)) {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/queue: ${where} body may not contain the reserved key "${REQUEUED_KEY}"`);
    }
};

/**
 * Validate a single send before it reaches any binding: the delay ceiling and the
 * reserved requeue key. Shared with topic publishes, which check once and then
 * send to every subscription.
 */
const assertSendable = (body: unknown, options: QueueSendOptions | undefined, where: string): void => {
    assertDelay(options?.delaySeconds, where);
    assertNoRequeueKey(body, where);
};

/**
 * Validate a batch and return it materialized, so it can both be counted against
 * the cap and forwarded unchanged (an Iterable can only be consumed once).
 */
const prepareBatch = (messages: Iterable<MessageSendRequestLike>, options: QueueSendBatchOptions | undefined, where: string): MessageSendRequestLike[] => {
    assertDelay(options?.delaySeconds, where);

    const batch = [...messages];

    if (batch.length > MAX_QUEUE_BATCH) {
        // `VALIDATION_ERROR` rather than a bare `Error` so it carries a code and a
        // 400: the caller passed too many messages, which is not a server fault.
        // The mirrored guard in `@lunora/scheduler` throws the same way.
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/queue: ${where} exceeds ${String(MAX_QUEUE_BATCH)} (got ${String(batch.length)}) — split across calls`,
        );
    }

    for (const [index, message] of batch.entries()) {
        assertSendable(message.body, message, `${where} message ${String(index)}`);
    }

    return batch;
};

/** Wrap a single Cloudflare `Queue` binding in the {@link QueueProducer} surface. */
const producerFor = (binding: QueueBindingLike): QueueProducer => {
    return {
        // Both are `async`, so a guard's `throw` surfaces as a rejection (never a
        // synchronous throw), matching a real producer's async surface.
        send: async (body: unknown, options?: QueueSendOptions): Promise<void> => {
            assertSendable(body, options, "send");

            await binding.send(body, options);
        },
        sendBatch: async (messages: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
            await binding.sendBatch(prepareBatch(messages, options, "sendBatch"), options);
        },
    };
};

/** `env[name]` when it is a usable `Queue` producer binding, else `undefined`. */
const resolveQueueBinding = (env: Record<string, unknown>, name: string): QueueBindingLike | undefined => {
    const binding = env[name] as QueueBindingLike | undefined;

    return binding && typeof binding.send === "function" && typeof binding.sendBatch === "function" ? binding : undefined;
};

/**
 * A by-name lookup where an unknown name resolves to `missing(reject)` instead of
 * `undefined`, so `ctx.queues.typo.send(...)` rejects with a directed error naming
 * what IS declared. Null-prototype, so a name like `constructor` can't resolve to
 * an inherited Object member.
 */
const namedLookup = <T>(entries: Record<string, T>, noun: string, missing: (reject: () => Promise<never>) => T): Record<string, T> => {
    const target: Record<string, T> = Object.assign(Object.create(null) as Record<string, T>, entries);
    const known = Object.keys(target);
    const suffix = known.length === 0 ? `no ${noun}s are declared` : `known ${noun}s: ${known.join(", ")}`;

    return new Proxy(target, {
        get(lookup, property): T | undefined {
            if (typeof property !== "string") {
                // Symbol access (e.g. `Symbol.toPrimitive`) is not a lookup.
                return undefined;
            }

            if (Object.hasOwn(lookup, property)) {
                return lookup[property];
            }

            return missing(() => Promise.reject(new Error(`@lunora/queue: no ${noun} named "${property}" (${suffix})`)));
        },
    });
};

/**
 * Build the `ctx.queues` map from `lunora/queues.ts` export name → Cloudflare
 * `Queue` binding. Each property is a typed {@link QueueProducer}; accessing an
 * export whose binding is absent throws a directed error naming the declared
 * queues (raised lazily on first use).
 */
const createQueues = (options: LunoraQueuesOptions): Queues => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- guards untrusted JS callers despite the required type
    const bindings = options.bindings ?? {};
    const producers: Record<string, QueueProducer> = {};

    for (const [exportName, binding] of Object.entries(bindings)) {
        producers[exportName] = producerFor(binding);
    }

    return namedLookup(producers, "queue", (reject) => {
        return { send: reject, sendBatch: reject };
    });
};

export { assertSendable, createQueues, namedLookup, prepareBatch, resolveQueueBinding };
