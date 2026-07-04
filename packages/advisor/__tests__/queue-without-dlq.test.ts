import { defineSchema, defineTable } from "@lunora/server";
import { v } from "@lunora/values";
import { describe, expect, it } from "vitest";

import type { AdvisorQueue, LintContext } from "../src";
import { fromServerSchema } from "../src";
import queueWithoutDlq from "../src/lints/static/queue-without-dlq";

const schema = () => fromServerSchema(defineSchema({ channels: defineTable({ name: v.string() }) }));

const context = (parts: Partial<LintContext>): LintContext => {
    return { schema: schema(), ...parts };
};

/** A push queue with no dead-letter queue (the flagged shape). */
const NOTIFICATIONS: AdvisorQueue = { exportName: "notifications", mode: "push", name: "notifications", tuning: {} };

describe("queue_without_dlq", () => {
    it("finds nothing when no declaration evidence is supplied", () => {
        expect.assertions(1);

        // A runtime caller (no queue feeder) must not flag anything.
        expect(queueWithoutDlq.run(context({}))).toHaveLength(0);
    });

    it("flags a queue that declares no deadLetterQueue", () => {
        expect.assertions(2);

        const findings = queueWithoutDlq.run(context({ queues: [NOTIFICATIONS] }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({
            cacheKey: "queue_without_dlq:notifications",
            level: "WARN",
            metadata: { maxRetries: 3, mode: "push", queue: "notifications" },
            name: "queue_without_dlq",
        });
    });

    it("reports the declared maxRetries in the detail and metadata", () => {
        expect.assertions(2);

        const queue: AdvisorQueue = { exportName: "emails", mode: "push", name: "emails", tuning: { maxRetries: 5 } };
        const findings = queueWithoutDlq.run(context({ queues: [queue] }));

        expect(findings[0]).toMatchObject({ metadata: { maxRetries: 5 } });
        expect(findings[0]?.detail).toContain("`maxRetries` = 5");
    });

    it("clears a queue that routes exhausted messages to a DLQ", () => {
        expect.assertions(1);

        const queue: AdvisorQueue = { exportName: "notifications", mode: "push", name: "notifications", tuning: { deadLetterQueue: "notifications-dlq" } };

        expect(queueWithoutDlq.run(context({ queues: [queue] }))).toHaveLength(0);
    });

    it("treats an empty-string deadLetterQueue as absent", () => {
        expect.assertions(1);

        const queue: AdvisorQueue = { exportName: "notifications", mode: "push", name: "notifications", tuning: { deadLetterQueue: "" } };

        expect(queueWithoutDlq.run(context({ queues: [queue] }))).toHaveLength(1);
    });

    it("does not flag a queue that is itself another queue's DLQ target", () => {
        expect.assertions(1);

        // The best-practice scaffold: `notifications` routes to `notifications-dlq`,
        // and `notificationsDlq` (wrangler name `notifications-dlq`) is the terminal
        // sink — it must not be flagged for lacking its own DLQ.
        const main: AdvisorQueue = { exportName: "notifications", mode: "push", name: "notifications", tuning: { deadLetterQueue: "notifications-dlq" } };
        const dlq: AdvisorQueue = { exportName: "notificationsDlq", mode: "push", name: "notifications-dlq", tuning: {} };

        expect(queueWithoutDlq.run(context({ queues: [main, dlq] }))).toHaveLength(0);
    });

    it("flags only the queues that lack a DLQ", () => {
        expect.assertions(1);

        const withDlq: AdvisorQueue = { exportName: "notifications", mode: "push", name: "notifications", tuning: { deadLetterQueue: "notifications-dlq" } };
        const withoutDlq: AdvisorQueue = { exportName: "webhooks", mode: "push", name: "webhooks", tuning: {} };
        const dlq: AdvisorQueue = { exportName: "notificationsDlq", mode: "push", name: "notifications-dlq", tuning: {} };

        const findings = queueWithoutDlq.run(context({ queues: [withDlq, withoutDlq, dlq] }));

        expect(findings.map((finding) => finding.metadata.queue)).toStrictEqual(["webhooks"]);
    });

    it("flags a pull-mode queue with no DLQ too", () => {
        expect.assertions(1);

        const queue: AdvisorQueue = { exportName: "ingest", mode: "pull", name: "ingest", tuning: {} };

        expect(queueWithoutDlq.run(context({ queues: [queue] }))).toHaveLength(1);
    });
});
