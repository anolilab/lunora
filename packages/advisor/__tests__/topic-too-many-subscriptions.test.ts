import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorQueue, LintContext } from "../src";
import { fromServerSchema } from "../src";
import topicTooManySubscriptions from "../src/lints/static/topic-too-many-subscriptions";

const schema = () => fromServerSchema(defineSchema({ channels: defineTable({ name: v.string() }) }));

const context = (parts: Partial<LintContext>): LintContext => {
    return { schema: schema(), ...parts };
};

const subscriptions = (topic: string, count: number): AdvisorQueue[] =>
    Array.from({ length: count }, (_, index) => {
        return { exportName: `${topic}Sub${String(index)}`, mode: "push", name: `${topic}-sub-${String(index)}`, topic, tuning: {} };
    });

describe("topic_too_many_subscriptions", () => {
    it("finds nothing when no declaration evidence is supplied", () => {
        expect.assertions(1);

        expect(topicTooManySubscriptions.run(context({}))).toHaveLength(0);
    });

    it("does not flag a topic at the threshold", () => {
        expect.assertions(1);

        expect(topicTooManySubscriptions.run(context({ queues: subscriptions("signups", 10) }))).toHaveLength(0);
    });

    it("flags a topic past the threshold, listing its subscriptions", () => {
        expect.assertions(2);

        const findings = topicTooManySubscriptions.run(context({ queues: [...subscriptions("signups", 11), ...subscriptions("orders", 2)] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "topic_too_many_subscriptions:signups",
            level: "INFO",
            metadata: { subscriptions: subscriptions("signups", 11).map((queue) => queue.exportName), topic: "signups" },
            name: "topic_too_many_subscriptions",
        });
    });

    it("ignores plain queues", () => {
        expect.assertions(1);

        const queues: AdvisorQueue[] = Array.from({ length: 12 }, (_, index) => {
            return { exportName: `queue${String(index)}`, mode: "push", name: `queue-${String(index)}`, tuning: {} };
        });

        expect(topicTooManySubscriptions.run(context({ queues }))).toHaveLength(0);
    });
});
