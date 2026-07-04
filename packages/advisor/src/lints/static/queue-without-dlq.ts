import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a declared queue that has no dead-letter queue.
 *
 * A Cloudflare Queues consumer retries a failing message up to `maxRetries`
 * times (default 3 — roughly four total delivery attempts); once that budget is
 * exhausted, a message with no `deadLetterQueue` is **deleted permanently** with
 * no record an operator can inspect. Routing exhausted messages to a DLQ turns
 * silent data loss into a backlog you can inspect, alert on, and replay. Hence
 * `WARN`/`INTERNAL`: an operator-facing reliability nudge, not a hard error — a
 * genuinely fire-and-forget queue may accept the loss.
 *
 * A queue that is itself some other queue's `deadLetterQueue` target is skipped:
 * a DLQ is a terminal sink and requiring it to have its own DLQ would recurse
 * forever (and mis-flag the best-practice scaffold, which pairs a queue with a
 * dedicated DLQ consumer).
 *
 * Only runs when the declaration feeder supplied evidence (`context.queues`
 * present); a runtime caller flags nothing.
 */
const queueWithoutDlq: Lint = {
    categories: ["SCHEMA"],
    description:
        "A queue consumer drops a message once it exhausts `maxRetries` (default 3) delivery attempts. Without a `deadLetterQueue`, that message is deleted permanently with no record — route exhausted messages to a DLQ so you can inspect, alert on, and replay them.",
    facing: "INTERNAL",
    level: "WARN",
    name: "queue_without_dlq",
    remediation:
        'Add `deadLetterQueue: "<name>-dlq"` to the `defineQueue({...})` options and declare a consumer for that queue so exhausted messages are inspectable (an unconsumed DLQ still expires at the retention window). `vis generate lunora-queue` with the best-practice setup scaffolds both. If the queue is fire-and-forget and message loss is acceptable, this advisory can be ignored.',
    run: (context) => {
        // No declaration evidence → nothing to assert (mirrors the other feeders).
        if (context.queues === undefined) {
            return [];
        }

        // Wrangler names some queue routes exhausted messages to. A queue whose
        // own name appears here is a DLQ (a terminal sink) and is not required to
        // declare its own DLQ.
        const dlqTargets = new Set(
            context.queues.map((queue) => queue.tuning.deadLetterQueue).filter((name): name is string => name !== undefined && name !== ""),
        );

        const findings = [];

        for (const queue of context.queues) {
            const dlq = queue.tuning.deadLetterQueue;

            if (dlq !== undefined && dlq !== "") {
                continue;
            }

            if (dlqTargets.has(queue.name)) {
                continue;
            }

            const maxRetries = typeof queue.tuning.maxRetries === "number" ? queue.tuning.maxRetries : 3;

            findings.push(
                emit(queueWithoutDlq, {
                    cacheKey: `queue_without_dlq:${queue.exportName}`,
                    detail: `Queue "${queue.exportName}" declares no \`deadLetterQueue\`, so a message that exhausts its retries (\`maxRetries\` = ${String(maxRetries)}, ~${String(maxRetries + 1)} delivery attempts) is dropped and permanently lost.`,
                    metadata: { maxRetries, mode: queue.mode, queue: queue.exportName },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Queue has no dead-letter queue",
};

export default queueWithoutDlq;
