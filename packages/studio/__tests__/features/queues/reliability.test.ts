import { describe, expect, it } from "vitest";

import { computeQueueReliability } from "../../../src/features/queues/reliability";
import type { QueueMessageRow, QueueMetadata } from "../../../src/lib/admin";

const queue = (overrides: Partial<QueueMetadata> & Pick<QueueMetadata, "exportName">): QueueMetadata => {
    return {
        binding: `QUEUE_${overrides.exportName.toUpperCase()}`,
        mode: "push",
        name: overrides.exportName,
        ...overrides,
    };
};

const message = (overrides: Partial<QueueMessageRow> & Pick<QueueMessageRow, "id">): QueueMessageRow => {
    return {
        attempts: 1,
        body: null,
        capturedAt: 0,
        deadLettered: false,
        messageId: overrides.id,
        outcome: "ack",
        queue: "notifications",
        timestamp: 0,
        ...overrides,
    };
};

describe("computeQueueReliability", () => {
    it("flags nothing when every queue has a dead-letter queue", () => {
        expect.assertions(2);

        const result = computeQueueReliability(
            [
                queue({ deadLetterQueue: "notifications-dlq", exportName: "notifications" }),
                queue({ exportName: "notificationsDlq", name: "notifications-dlq" }),
            ],
            [],
        );

        expect(result.queuesWithoutDlq).toStrictEqual([]);
        expect(result.showReliabilityWarning).toBe(false);
    });

    it("flags a push queue with no dead-letter queue", () => {
        expect.assertions(3);

        const result = computeQueueReliability([queue({ exportName: "notifications" })], []);

        expect(result.queuesWithoutDlq).toHaveLength(1);
        expect(result.queuesWithoutDlq[0]?.exportName).toBe("notifications");
        expect(result.showReliabilityWarning).toBe(true);
    });

    it("flags a pull queue with no dead-letter queue too (mode-agnostic, mirrors the advisor)", () => {
        expect.assertions(1);

        const result = computeQueueReliability([queue({ exportName: "ingest", mode: "pull" })], []);

        expect(result.queuesWithoutDlq).toHaveLength(1);
    });

    it("treats an empty-string dead-letter queue as absent", () => {
        expect.assertions(1);

        const result = computeQueueReliability([queue({ deadLetterQueue: "", exportName: "notifications" })], []);

        expect(result.queuesWithoutDlq).toHaveLength(1);
    });

    it("never flags a queue that is itself another queue's dead-letter target", () => {
        expect.assertions(2);

        // The sink declares no DLQ of its own, but it is `notifications`'s target,
        // so it must not be flagged — only the unprotected `orders` queue is.
        const result = computeQueueReliability(
            [
                queue({ deadLetterQueue: "notifications-dlq", exportName: "notifications" }),
                queue({ exportName: "notificationsDlq", name: "notifications-dlq" }),
                queue({ exportName: "orders" }),
            ],
            [],
        );

        expect(result.queuesWithoutDlq.map((entry) => entry.exportName)).toStrictEqual(["orders"]);
        expect(result.showReliabilityWarning).toBe(true);
    });

    it("counts only the dead-lettered messages in the loaded window", () => {
        expect.assertions(2);

        const result = computeQueueReliability(
            [
                queue({ deadLetterQueue: "notifications-dlq", exportName: "notifications" }),
                queue({ exportName: "notificationsDlq", name: "notifications-dlq" }),
            ],
            [message({ deadLettered: true, id: "a" }), message({ id: "b" }), message({ deadLettered: true, id: "c" })],
        );

        expect(result.deadLetteredCount).toBe(2);
        // No unprotected queue, but dead-lettered messages alone still warn.
        expect(result.showReliabilityWarning).toBe(true);
    });
});
