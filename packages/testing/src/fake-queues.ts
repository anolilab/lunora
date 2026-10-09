/**
 * The recording `ctx.queues` the `lunoraTest` harness hands mutation and action
 * contexts. Each declared queue gets a recording producer binding, wrapped in
 * `@lunora/queue`'s own `createQueues` — so the batch cap, the delay ceiling and
 * the reserved-key check reject in a test exactly as they do in production, and
 * an undeclared name rejects naming the declared ones.
 */
import { LunoraError } from "@lunora/errors";
import type { MessageSendRequestLike, QueueBindingLike, Queues, QueueSendBatchOptions, QueueSendOptions } from "@lunora/queue";
import { createQueues } from "@lunora/queue";

/** One message a handler enqueued through `ctx.queues.<name>`. */
interface SentQueueMessage {
    body: unknown;
    contentType?: QueueSendOptions["contentType"];
    delaySeconds?: number;
    /** The `lunora/queues.ts` export name the message was sent through. */
    queue: string;
}

/**
 * Inspect what handlers enqueued. Production sends are not transactional — a
 * mutation that throws after `ctx.queues.x.send(...)` has still sent it — so the
 * record keeps those too. Nothing is consumed: a test asserts on the messages and
 * drives the consumer itself if it wants to.
 */
interface FakeQueueControls {
    /** Forget every recorded message. */
    clear: () => void;
    /** Recorded messages in send order, optionally only those sent to `queue`; an undeclared `queue` throws. */
    sent: (queue?: string) => SentQueueMessage[];
}

const createFakeQueues = (names: ReadonlyArray<string>): { controls: FakeQueueControls; queues: Queues } => {
    const declared = new Set(names);
    const messages: SentQueueMessage[] = [];

    const record = (queue: string, body: unknown, options: QueueSendOptions | undefined): void => {
        messages.push({
            body,
            ...(options?.contentType === undefined ? {} : { contentType: options.contentType }),
            ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
            queue,
        });
    };

    const bindingFor = (queue: string): QueueBindingLike => {
        return {
            send: (body: unknown, options?: QueueSendOptions): Promise<void> => {
                record(queue, body, options);

                return Promise.resolve();
            },
            sendBatch: (batch: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
                // A message's own delay wins over the batch's, as on Cloudflare.
                for (const message of batch) {
                    record(queue, message.body, { contentType: message.contentType, delaySeconds: message.delaySeconds ?? options?.delaySeconds });
                }

                return Promise.resolve();
            },
        };
    };

    const queues = createQueues({ bindings: Object.fromEntries([...declared].map((name) => [name, bindingFor(name)])) });

    const controls: FakeQueueControls = {
        clear: () => {
            messages.length = 0;
        },
        sent: (queue) => {
            if (queue === undefined) {
                return [...messages];
            }

            if (!declared.has(queue)) {
                throw new LunoraError(
                    "INTERNAL",
                    `harness.queues.sent("${queue}"): no such queue — declared: ${declared.size === 0 ? "(none; pass lunoraTest(schema, { queues: [...] }))" : [...declared].join(", ")}`,
                );
            }

            return messages.filter((message) => message.queue === queue);
        },
    };

    return { controls, queues };
};

export type { FakeQueueControls, SentQueueMessage };
export { createFakeQueues };
