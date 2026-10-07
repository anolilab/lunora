import { bench, describe } from "vitest";

import { createTopicContext } from "../src/topics";
import type { QueueBindingLike } from "../src/types";

/**
 * `ctx.topics.<name>.publish` sends once per subscription, so its cost grows
 * with the subscription count. The bindings resolve immediately, so this
 * measures Lunora's own fan-out overhead (validation, one `send` per queue,
 * `Promise.all`), not the network. 10 is where `topic_too_many_subscriptions`
 * starts flagging; 25 is past it.
 */

const binding: QueueBindingLike = {
    send: async () => {},
    sendBatch: async () => {},
};

const topicWith = (count: number) => {
    const subscriptions = Array.from({ length: count }, (_, index) => {
        return { binding: `QUEUE_SUB_${String(index)}`, exportName: `sub${String(index)}` };
    });
    const env = Object.fromEntries(subscriptions.map((subscription) => [subscription.binding, binding]));

    const { signups } = createTopicContext(env, [{ exportName: "signups", subscriptions }]);

    if (signups === undefined) {
        throw new Error("createTopicContext returned no `signups` publisher");
    }

    return signups;
};

const payload = { plan: "pro", userId: "users:42" };
const batch = Array.from({ length: 20 }, (_, index) => {
    return { body: { ...payload, userId: `users:${String(index)}` } };
});

describe("topic publish", () => {
    for (const count of [1, 5, 10, 25]) {
        const topic = topicWith(count);

        bench(`publish to ${String(count)} subscriptions`, async () => {
            await topic.publish(payload);
        });
    }
});

describe("topic publishBatch (20 messages)", () => {
    for (const count of [1, 10, 25]) {
        const topic = topicWith(count);

        bench(`publishBatch to ${String(count)} subscriptions`, async () => {
            await topic.publishBatch(batch);
        });
    }
});
