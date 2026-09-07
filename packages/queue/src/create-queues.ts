/**
 * `ctx.queues` — a thin, typed pass-through over the Cloudflare `Queue` producer
 * bindings. Node-safe (structural binding types), so it's exercised by unit
 * tests with plain-object doubles.
 */
import { LunoraError } from "@lunora/errors";

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

/** Wrap a single Cloudflare `Queue` binding in the {@link QueueProducer} surface. */
const producerFor = (binding: QueueBindingLike): QueueProducer => {
    return {
        send: async (body: unknown, options?: QueueSendOptions): Promise<void> => {
            assertDelay(options?.delaySeconds, "send");

            await binding.send(body, options);
        },
        sendBatch: async (messages: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
            assertDelay(options?.delaySeconds, "sendBatch");

            // Materialize so the array can both be counted against the cap and
            // forwarded unchanged to the binding (an Iterable can only be
            // consumed once).
            const batch = [...messages];

            if (batch.length > MAX_QUEUE_BATCH) {
                // A `throw` inside this `async` function still surfaces to the
                // caller as an async rejection (never a synchronous throw) —
                // matching the `missing` producer's convention below and a real
                // producer's async surface. `VALIDATION_ERROR` rather than a
                // bare `Error` so it carries a code and a 400: the caller passed
                // too many messages, which is not a server fault. The mirrored
                // guard in `@lunora/scheduler` throws the same way.
                throw new LunoraError(
                    "VALIDATION_ERROR",
                    `@lunora/queue: sendBatch exceeds ${String(MAX_QUEUE_BATCH)} (got ${String(batch.length)}) — split across calls`,
                );
            }

            for (const [index, message] of batch.entries()) {
                assertDelay(message.delaySeconds, `sendBatch message ${String(index)}`);
            }

            await binding.sendBatch(batch, options);
        },
    };
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
    // Null-prototype map so a queue named `constructor` / `toString` / `hasOwnProperty`
    // can't resolve to an inherited Object member instead of the directed error.
    const producers: Record<string, QueueProducer> = Object.create(null) as Record<string, QueueProducer>;

    for (const [exportName, binding] of Object.entries(bindings)) {
        producers[exportName] = producerFor(binding);
    }

    const known = Object.keys(producers);
    const missing = (name: string): QueueProducer => {
        const suffix = known.length === 0 ? "no queues are declared" : `known queues: ${known.join(", ")}`;
        // Reject (don't throw synchronously) so `ctx.queues.<name>.send(...)` is a
        // normal awaitable that rejects, matching a real producer's async surface.
        const error = (): Promise<never> => Promise.reject(new Error(`@lunora/queue: no queue named "${name}" (${suffix})`));

        return { send: error, sendBatch: error };
    };

    return new Proxy(producers, {
        get(target, property): QueueProducer | undefined {
            if (typeof property !== "string") {
                // Symbol access (e.g. `Symbol.toPrimitive`) is not a queue lookup.
                return undefined;
            }

            return Object.hasOwn(target, property) ? target[property] : missing(property);
        },
    });
};

export default createQueues;
