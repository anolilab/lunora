/**
 * Pub/Sub topics over Cloudflare Queues. A queue has exactly one consumer, so a
 * topic cannot be one queue: each `defineSubscription` IS a push queue (its own
 * retries and dead-letter queue), and `ctx.topics.<name>.publish` sends to every
 * subscription's queue. Codegen links subscription → topic statically; nothing
 * here knows export names.
 *
 * Node-safe (structural binding types only), like `create-queues.ts`.
 */
import { assertSendable, namedLookup, prepareBatch, resolveQueueBinding } from "./create-queues";
import type {
    MessageSendRequestLike,
    QueueBindingLike,
    QueueSendBatchOptions,
    QueueSendOptions,
    SubscriptionConfig,
    SubscriptionDefinition,
    TopicBindingSpec,
    TopicDefinition,
    TopicPublisher,
    Topics,
} from "./types";

/**
 * Declare a topic in `lunora/queues.ts`. The payload type is the only thing a
 * topic carries; delivery config lives on each subscription.
 */
const defineTopic = <Payload = unknown>(): TopicDefinition<Payload> => {
    return { isLunoraTopic: true };
};

/** True when a value is a `defineTopic` result (the runtime brand check). */
const isTopicDefinition = (value: unknown): value is TopicDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraTopic?: unknown }).isLunoraTopic === true;

/**
 * Subscribe to a topic. The result is a push queue definition — export it from
 * `lunora/queues.ts` and it deploys, retries and dead-letters exactly like a
 * `defineQueue` export of the same name.
 *
 * ⚠️ Same trust model as a queue handler: `message.run(...)` dispatches with the
 * system identity, so validate `message.body` before acting on it.
 */
const defineSubscription = <Payload>(topic: TopicDefinition<Payload>, config: SubscriptionConfig<Payload>): SubscriptionDefinition<Payload> => {
    if (!isTopicDefinition(topic)) {
        throw new TypeError("defineSubscription: the first argument must be a `defineTopic()` result");
    }

    if (typeof config.handler !== "function") {
        throw new TypeError("defineSubscription: `handler` must be a function");
    }

    if (config.name !== undefined && (typeof config.name !== "string" || config.name.length === 0)) {
        throw new TypeError("defineSubscription: `name` must be a non-empty string when provided");
    }

    return { ...config, isLunoraQueue: true, mode: "push", topic };
};

/**
 * One topic's publisher. Validates once, then sends to every subscription's queue
 * in parallel — so a transient send failure rejects the publish after the other
 * subscriptions already got their copy, and a retry re-delivers to them.
 */
const publisherFor = (bindings: ReadonlyArray<QueueBindingLike>): TopicPublisher => {
    return {
        publish: async (payload: unknown, options?: QueueSendOptions): Promise<void> => {
            assertSendable(payload, options, "publish");

            await Promise.all(bindings.map(async (binding) => binding.send(payload, options)));
        },
        publishBatch: async (messages: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
            const batch = prepareBatch(messages, options, "publishBatch");

            await Promise.all(bindings.map(async (binding) => binding.sendBatch(batch, options)));
        },
    };
};

/**
 * A publisher for a topic with a subscription this Worker has no binding for. It
 * rejects before sending anything: the gap is configuration, so sending to the
 * bound subscriptions would hand them a duplicate on every retry, forever.
 */
const unboundPublisher = (unbound: ReadonlyArray<string>): TopicPublisher => {
    const reject = (): Promise<never> =>
        Promise.reject(
            new Error(
                `@lunora/queue: missing queue binding(s) ${unbound.join(", ")} — add them to wrangler.jsonc (lunora dev reconciles them); nothing was published`,
            ),
        );

    return { publish: reject, publishBatch: reject };
};

/**
 * Build `ctx.topics` for a request from the Worker `env` and the codegen-emitted
 * specs. A topic with no subscriptions publishes to nobody; a topic with an
 * unbound subscription rejects every publish (see {@link unboundPublisher}).
 */
const createTopicContext = (env: Record<string, unknown>, specs: ReadonlyArray<TopicBindingSpec>): Topics => {
    const publishers: Record<string, TopicPublisher> = {};

    for (const spec of specs) {
        const bound: QueueBindingLike[] = [];
        const unbound: string[] = [];

        for (const subscription of spec.subscriptions) {
            const binding = resolveQueueBinding(env, subscription.binding);

            if (binding) {
                bound.push(binding);
            } else {
                unbound.push(subscription.binding);
            }
        }

        publishers[spec.exportName] = unbound.length > 0 ? unboundPublisher(unbound) : publisherFor(bound);
    }

    return namedLookup(publishers, "topic", (reject) => {
        return { publish: reject, publishBatch: reject };
    });
};

export { createTopicContext, defineSubscription, defineTopic };
