import type { QueueMessageRow, QueueMetadata } from "../../lib/admin";

/** The Queues panel's reliability-banner state, derived by {@link computeQueueReliability}. */
export interface QueueReliability {
    /** Messages in the loaded log window that a consumer dead-lettered (not a deployment-wide total). */
    deadLetteredCount: number;
    /** Declared queues (push or pull) with no `deadLetterQueue` that aren't themselves a DLQ target. */
    queuesWithoutDlq: ReadonlyArray<QueueMetadata>;
    /** Whether the reliability banner should render at all. */
    showReliabilityWarning: boolean;
}

/**
 * Derive the Queues panel's reliability-banner state from the declared-queue
 * metadata and the loaded consumed-message log.
 *
 * A queue is flagged when it declares no `deadLetterQueue`, regardless of mode: a
 * push *or* pull consumer drops a message once it exhausts its retries with no
 * DLQ set — so this mirrors the `queue_without_dlq` advisor, which flags both.
 * A queue that is itself another queue's DLQ target is excluded — a terminal sink
 * is meant to have no DLQ of its own.
 *
 * `deadLetteredCount` is over the loaded message window only (Cloudflare Queues
 * expose no peek API), so the banner phrases it as "recently", not as a total.
 */
export const computeQueueReliability = (queues: ReadonlyArray<QueueMetadata>, messages: ReadonlyArray<QueueMessageRow>): QueueReliability => {
    // Wrangler names some queue routes exhausted messages to. A queue whose own
    // name appears here is a DLQ (a terminal sink) and needs no DLQ of its own.
    const dlqTargets = new Set(queues.map((queue) => queue.deadLetterQueue).filter((name): name is string => typeof name === "string" && name !== ""));

    const queuesWithoutDlq = queues.filter((queue) => (queue.deadLetterQueue === undefined || queue.deadLetterQueue === "") && !dlqTargets.has(queue.name));
    const deadLetteredCount = messages.filter((message) => message.deadLettered).length;

    return {
        deadLetteredCount,
        queuesWithoutDlq,
        showReliabilityWarning: queuesWithoutDlq.length > 0 || deadLetteredCount > 0,
    };
};
