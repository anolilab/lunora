import { describe, expect, it, vi } from "vitest";

import { isQueueDefinition } from "../src/define-queue";
import { REQUEUED_KEY } from "../src/requeue-envelope";
import { createTopicContext, defineSubscription, defineTopic } from "../src/topics";
import type { QueueBindingLike, TopicBindingSpec } from "../src/types";

const fakeBinding = (): QueueBindingLike & { batches: unknown[]; sends: unknown[] } => {
    const sends: unknown[] = [];
    const batches: unknown[] = [];

    return {
        batches,
        send: vi.fn<(body: unknown, options?: unknown) => Promise<void>>(async (body, options) => {
            sends.push({ body, options });
        }),
        sendBatch: vi.fn<(messages: Iterable<unknown>, options?: unknown) => Promise<void>>(async (messages, options) => {
            batches.push({ messages: [...messages], options });
        }),
        sends,
    };
};

/** One `signups` topic whose subscriptions are bound as `QUEUE_<NAME>`. */
const signupsSpec = (...subscriptions: string[]): TopicBindingSpec[] => [
    {
        exportName: "signups",
        subscriptions: subscriptions.map((name) => {
            return { binding: `QUEUE_${name.toUpperCase()}`, exportName: name };
        }),
    },
];

describe("defineSubscription", () => {
    it("is a push queue definition tagged with its topic", () => {
        expect.assertions(4);

        const signups = defineTopic<{ userId: string }>();
        const welcome = defineSubscription(signups, { handler: () => {}, maxRetries: 5 });

        expect(isQueueDefinition(welcome)).toBe(true);
        expect(welcome.mode).toBe("push");
        expect(welcome.topic).toBe(signups);
        expect(welcome.maxRetries).toBe(5);
    });

    it("rejects a non-topic, a missing handler and an empty name", () => {
        expect.assertions(3);

        const topic = defineTopic();

        expect(() => defineSubscription({} as never, { handler: () => {} })).toThrow(/defineTopic/u);
        expect(() => defineSubscription(topic, {} as never)).toThrow(/handler/u);
        expect(() => defineSubscription(topic, { handler: () => {}, name: "" })).toThrow(/name/u);
    });
});

describe("createTopicContext", () => {
    it("publishes one copy to every subscription", async () => {
        expect.assertions(2);

        const welcome = fakeBinding();
        const audit = fakeBinding();
        const topics = createTopicContext({ QUEUE_AUDIT: audit, QUEUE_WELCOME: welcome }, signupsSpec("audit", "welcome"));

        await topics.signups!.publish({ userId: "u1" }, { delaySeconds: 5 });

        expect(welcome.sends).toEqual([{ body: { userId: "u1" }, options: { delaySeconds: 5 } }]);
        expect(audit.sends).toEqual(welcome.sends);
    });

    it("publishes a batch to every subscription", async () => {
        expect.assertions(2);

        const welcome = fakeBinding();
        const audit = fakeBinding();
        const topics = createTopicContext({ QUEUE_AUDIT: audit, QUEUE_WELCOME: welcome }, signupsSpec("audit", "welcome"));

        await topics.signups!.publishBatch([{ body: 1 }, { body: 2 }]);

        expect(welcome.batches).toEqual([{ messages: [{ body: 1 }, { body: 2 }], options: undefined }]);
        expect(audit.batches).toEqual(welcome.batches);
    });

    it("rejects when one subscription's send fails", async () => {
        expect.assertions(2);

        const welcome = fakeBinding();
        const broken: QueueBindingLike = {
            send: async () => {
                throw new Error("boom");
            },
            sendBatch: async () => {},
        };
        const topics = createTopicContext({ QUEUE_BROKEN: broken, QUEUE_WELCOME: welcome }, signupsSpec("broken", "welcome"));

        await expect(topics.signups!.publish({})).rejects.toThrow("boom");

        expect(welcome.sends).toHaveLength(1);
    });

    it("applies the queue guards before sending anything", async () => {
        expect.assertions(4);

        const welcome = fakeBinding();
        const topics = createTopicContext({ QUEUE_WELCOME: welcome }, signupsSpec("welcome"));

        await expect(topics.signups!.publish({}, { delaySeconds: 43_201 })).rejects.toThrow(/publish delaySeconds is 43201.*ceiling/u);
        await expect(topics.signups!.publish({ [REQUEUED_KEY]: 1 })).rejects.toThrow(/reserved key/u);
        await expect(
            topics.signups!.publishBatch(
                Array.from({ length: 101 }, (_, body) => {
                    return { body };
                }),
            ),
        ).rejects.toThrow(/publishBatch exceeds 100/u);

        expect(welcome.send).not.toHaveBeenCalled();
    });

    it("publishes to nobody when a topic has no subscriptions", async () => {
        expect.assertions(1);

        const topics = createTopicContext({}, signupsSpec());

        await expect(topics.signups!.publish({})).resolves.toBeUndefined();
    });

    it("rejects an undeclared topic, naming the declared ones", async () => {
        expect.assertions(1);

        const topics = createTopicContext({}, signupsSpec());

        await expect(topics.orders!.publish({})).rejects.toThrow('no topic named "orders" (known topics: signups)');
    });

    it("sends nothing when a subscription is unbound, naming the missing binding", async () => {
        expect.assertions(2);

        const welcome = fakeBinding();
        const topics = createTopicContext({ QUEUE_WELCOME: welcome }, signupsSpec("audit", "welcome"));

        await expect(topics.signups!.publish({ userId: "u1" })).rejects.toThrow(/missing queue binding\(s\) QUEUE_AUDIT .*nothing was published/u);

        expect(welcome.send).not.toHaveBeenCalled();
    });
});
