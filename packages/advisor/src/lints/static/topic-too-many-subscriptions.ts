import emit from "../../finding";
import type { Lint } from "../../types";

/** Subscriptions past which one publish noticeably stretches the calling handler. */
const MAX_SUBSCRIPTIONS = 10;

/**
 * Flags a topic with more than {@link MAX_SUBSCRIPTIONS} subscriptions.
 *
 * Each subscription is its own queue, so `ctx.topics.<name>.publish` is one
 * `send` per subscription. A Worker invocation holds at most six connections
 * waiting on a response, Queues `send` included, so past six the sends wait on
 * each other and the publish costs several round trips inside the mutation or
 * action that made it. The fan-out is also not atomic: one failed send rejects
 * the publish, and the caller's retry re-delivers to every subscription that
 * already got its copy, so duplicates grow with the count. `INFO`: a large
 * fan-out can be deliberate.
 *
 * Only runs when the declaration feeder supplied evidence (`context.queues`
 * present); a runtime caller flags nothing.
 */
const topicTooManySubscriptions: Lint = {
    categories: ["PERFORMANCE"],
    description: `A topic with more than ${String(MAX_SUBSCRIPTIONS)} subscriptions makes every publish one queue send per subscription. A Worker runs at most six sends at once, so the publish adds several round trips to the calling handler, and a retried publish re-delivers to every subscription that already received it.`,
    facing: "INTERNAL",
    level: "INFO",
    name: "topic_too_many_subscriptions",
    remediation:
        "Fold subscriptions that do related work into one handler, or publish from an action instead of a mutation so the fan-out is off the write path. Keep every subscription handler idempotent: a retried publish re-delivers to all of them.",
    run: (context) => {
        if (context.queues === undefined) {
            return [];
        }

        const subscriptionsByTopic = Map.groupBy(
            context.queues.filter((queue) => queue.topic !== undefined),
            (queue) => queue.topic as string,
        );

        const findings = [];

        for (const [topic, subscriptions] of subscriptionsByTopic) {
            if (subscriptions.length <= MAX_SUBSCRIPTIONS) {
                continue;
            }

            findings.push(
                emit(topicTooManySubscriptions, {
                    cacheKey: `topic_too_many_subscriptions:${topic}`,
                    detail: `Topic "${topic}" has ${String(subscriptions.length)} subscriptions, so each publish sends to ${String(subscriptions.length)} queues.`,
                    metadata: { subscriptions: subscriptions.map((queue) => queue.exportName), topic },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Topic has many subscriptions",
};

export default topicTooManySubscriptions;
