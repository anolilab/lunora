import type { QueueMetadata } from "../../lib/admin";

/** A Send-tab target that publishes to every subscription of a topic, rather than one queue. */
const TOPIC_TARGET_PREFIX = "topic:";

/** The declared queues split into plain queues and each topic's subscriptions, in one pass. */
const groupByTopic = (queues: ReadonlyArray<QueueMetadata>): { plain: QueueMetadata[]; topics: Map<string, QueueMetadata[]> } => {
    const plain: QueueMetadata[] = [];
    const topics = new Map<string, QueueMetadata[]>();

    for (const queue of queues) {
        if (queue.topic === undefined) {
            plain.push(queue);
        } else {
            topics.set(queue.topic, [...(topics.get(queue.topic) ?? []), queue]);
        }
    }

    return { plain, topics };
};

/** The Send-tab value that publishes to `topic`. */
const topicTarget = (topic: string): string => `${TOPIC_TARGET_PREFIX}${topic}`;

/**
 * The queue export names a Send-tab target reaches: a topic target fans out to
 * each of its subscriptions (what `ctx.topics.<name>.publish` does), any other
 * target is the one queue it names.
 */
const sendTargets = (target: string, topics: ReadonlyMap<string, ReadonlyArray<QueueMetadata>>): string[] =>
    target.startsWith(TOPIC_TARGET_PREFIX) ? (topics.get(target.slice(TOPIC_TARGET_PREFIX.length)) ?? []).map((queue) => queue.exportName) : [target];

export { groupByTopic, sendTargets, topicTarget };
