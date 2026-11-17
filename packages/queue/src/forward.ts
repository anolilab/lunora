/**
 * `dispatchForwardedQueueBatch` — runs a batch a platform consumer forwarded to
 * `POST /_lunora/queue` through the same {@link dispatchQueueBatch} a native
 * `queue()` entry uses. A Workers-for-Platforms tenant cannot be a queue
 * consumer, so the platform drains its queues and forwards plain
 * `{ id, body }` messages; this gives them the `MessageBatchLike` shape the
 * dispatch expects and turns their dispositions back into the ids to retry.
 */
import { toErrorBody } from "@lunora/errors";

import type { DispatchOptions, QueueRegistry } from "./dispatch";
import { dispatchQueueBatch } from "./dispatch";
import type { MessageBatchLike, MessageLike } from "./types";

/** A batch as the platform consumer forwards it (`QueueForwardBatch` in `@lunora/runtime`). */
interface ForwardedQueueBatch {
    messages: ReadonlyArray<{ body: unknown; id: string }>;
    queue: string;
}

/** How a platform names a queue resource after a binding: lower-case, `_` → `-` (`QUEUE_JOBS` → `queue-jobs`). */
const resourceFormOf = (binding: string): string => binding.toLowerCase().replaceAll("_", "-");

/**
 * The registry key a forwarded batch routes to. A platform provisions its own
 * queue per tenant binding, so the name it forwards is the binding, not the
 * name the app declared; a declared (or per-environment) name still routes as is.
 */
const resolveForwardedQueue = (queue: string, registry: QueueRegistry): string => {
    if (Object.hasOwn(registry, queue)) {
        return queue;
    }

    const wanted = resourceFormOf(queue);
    const match = Object.entries(registry).find(([, entry]) => entry.binding !== undefined && resourceFormOf(entry.binding) === wanted);

    // Unresolved: the dispatch's own error names the queue and the declared ones.
    return match === undefined ? queue : match[0];
};

/**
 * Dispatch a forwarded batch and answer the ids to retry. A message the handler
 * left alone is acked, as Cloudflare acks one on a clean return; when the
 * handler fails the whole batch, every message it did not ack is retried.
 * Delays asked for on a retry are dropped: the forward protocol carries only ids.
 */
const dispatchForwardedQueueBatch = async (forwarded: ForwardedQueueBatch, registry: QueueRegistry, options: DispatchOptions): Promise<{ retry: string[] }> => {
    const outcomes = new Map<string, "ack" | "retry">();
    const receivedAt = new Date();
    const messages: MessageLike[] = forwarded.messages.map((message) => {
        return {
            ack: () => {
                outcomes.set(message.id, "ack");
            },
            // The forward protocol does not carry the platform's attempt count.
            attempts: 1,
            body: message.body,
            id: message.id,
            retry: () => {
                outcomes.set(message.id, "retry");
            },
            timestamp: receivedAt,
        };
    });
    const batch: MessageBatchLike = {
        ackAll: () => {
            for (const message of messages) {
                outcomes.set(message.id, "ack");
            }
        },
        messages,
        queue: resolveForwardedQueue(forwarded.queue, registry),
        retryAll: () => {
            for (const message of messages) {
                outcomes.set(message.id, "retry");
            }
        },
    };

    try {
        await dispatchQueueBatch(batch, registry, options);
    } catch (error) {
        // A native consumer re-throws and the runtime logs it; answering retry ids instead
        // would leave the failure with no trace, so it is logged here, redacted as dispatch.ts does.
        const { body } = toErrorBody(error, { redactedMessage: "internal error" });

        // eslint-disable-next-line no-console -- no injected logger on the dispatch path; the batch is answered, not thrown
        console.error(`@lunora/queue: forwarded batch on queue "${forwarded.queue}" failed (${body.code}: ${body.message}); retrying its unacked messages.`);

        return { retry: messages.filter((message) => outcomes.get(message.id) !== "ack").map((message) => message.id) };
    }

    return { retry: messages.filter((message) => outcomes.get(message.id) === "retry").map((message) => message.id) };
};

export type { ForwardedQueueBatch };
export { dispatchForwardedQueueBatch };
