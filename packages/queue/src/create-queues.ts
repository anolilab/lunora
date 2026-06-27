/**
 * `ctx.queues` — a thin, typed pass-through over the Cloudflare `Queue` producer
 * bindings. Node-safe (structural binding types), so it's exercised by unit
 * tests with plain-object doubles.
 */
import type { LunoraQueuesOptions, MessageSendRequestLike, QueueBindingLike, QueueProducer, Queues, QueueSendBatchOptions, QueueSendOptions } from "./types";

/** Wrap a single Cloudflare `Queue` binding in the {@link QueueProducer} surface. */
const producerFor = (binding: QueueBindingLike): QueueProducer => {
    return {
        send: async (body: unknown, options?: QueueSendOptions): Promise<void> => {
            await binding.send(body, options);
        },
        sendBatch: async (messages: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
            await binding.sendBatch(messages, options);
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
