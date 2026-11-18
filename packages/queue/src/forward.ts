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
    /** `attempts` is the platform's delivery attempt; absent from a platform that does not send it, which counts as the first. */
    messages: ReadonlyArray<{ attempts?: number; body: unknown; id: string }>;
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

/** What a forwarded batch answers: the ids to retry, and the delay each retry asked for, in seconds. */
interface ForwardedQueueResult {
    retry: string[];
    retryDelays?: Record<string, number>;
}

/** The answer for `retry`, with the delays of those ids only. */
const answer = (retry: string[], delays: ReadonlyMap<string, number>): ForwardedQueueResult => {
    const retryDelays = Object.fromEntries(
        retry.flatMap((id) => {
            const delay = delays.get(id);

            return delay === undefined ? [] : [[id, delay] as const];
        }),
    );

    return Object.keys(retryDelays).length === 0 ? { retry } : { retry, retryDelays };
};

/**
 * Dispatch a forwarded batch and answer the ids to retry. A message the handler
 * left alone is acked, as Cloudflare acks one on a clean return; when the
 * handler fails the whole batch, every message it did not ack is retried.
 */
const dispatchForwardedQueueBatch = async (
    forwarded: ForwardedQueueBatch,
    registry: QueueRegistry,
    options: DispatchOptions,
): Promise<ForwardedQueueResult> => {
    const outcomes = new Map<string, "ack" | "retry">();
    // Carried back so the platform consumer retries with it: dropped, a declined
    // dispatch came straight back inside its claim and spent an attempt per round.
    const delays = new Map<string, number>();
    const retry = (id: string, delaySeconds: number | undefined): void => {
        outcomes.set(id, "retry");

        if (delaySeconds === undefined) {
            delays.delete(id);
        } else {
            delays.set(id, delaySeconds);
        }
    };
    const receivedAt = new Date();
    const messages: MessageLike[] = forwarded.messages.map((message) => {
        return {
            ack: () => {
                outcomes.set(message.id, "ack");
            },
            // The platform's count: a retry policy that sees only 1 never knows a delivery is the last.
            attempts: message.attempts ?? 1,
            body: message.body,
            id: message.id,
            retry: (retryOptions) => {
                retry(message.id, retryOptions?.delaySeconds);
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
        retryAll: (retryOptions) => {
            for (const message of messages) {
                retry(message.id, retryOptions?.delaySeconds);
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

        return answer(
            messages.filter((message) => outcomes.get(message.id) !== "ack").map((message) => message.id),
            delays,
        );
    }

    return answer(
        messages.filter((message) => outcomes.get(message.id) === "retry").map((message) => message.id),
        delays,
    );
};

export type { ForwardedQueueBatch, ForwardedQueueResult };
export { dispatchForwardedQueueBatch };
