/**
 * The recording `ctx.queues` the `lunoraTest` harness hands mutation and action
 * contexts. Each declared queue gets a recording producer binding, wrapped in
 * `@lunora/queue`'s own `createQueues` — so the batch cap, the delay ceiling and
 * the reserved-key check reject in a test exactly as they do in production, and
 * an undeclared name rejects naming the declared ones. Bodies are recorded as
 * structured clones, the way the default `v8` content type serializes them, so
 * a handler mutating a body after sending it does not rewrite the record and a
 * body that cannot cross the wire (a function) rejects.
 */
import { LunoraError } from "@lunora/errors";
import type { MessageSendRequestLike, QueueBindingLike, Queues, QueueSendBatchOptions, QueueSendOptions } from "@lunora/queue";
import { createQueues } from "@lunora/queue";

import { stubProxy, unavailable } from "./context-fakes";

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

/** `ctx.queues`: codegen adds it to mutation and action contexts when `lunora/queues.ts` declares queues. */
interface QueueSurface {
    queues: Queues;
}

const OPTION = "queues: [...]";

const createRecordingQueues = (names: ReadonlyArray<string>): { controls: FakeQueueControls; surfaces: QueueSurface } => {
    const declared = new Set(names);
    const messages: SentQueueMessage[] = [];

    const snapshot = (queue: string, body: unknown, options: QueueSendOptions | undefined): SentQueueMessage => {
        return {
            body: structuredClone(body),
            ...(options?.contentType === undefined ? {} : { contentType: options.contentType }),
            ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
            queue,
        };
    };

    const bindingFor = (queue: string): QueueBindingLike => {
        return {
            send: (body: unknown, options?: QueueSendOptions): Promise<void> => {
                messages.push(snapshot(queue, body, options));

                return Promise.resolve();
            },
            sendBatch: (batch: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
                // A message's own delay wins over the batch's, as on Cloudflare. Snapshot
                // the whole batch before recording any, so an unclonable body records none.
                const sent = [...batch].map((message) =>
                    snapshot(queue, message.body, { contentType: message.contentType, delaySeconds: message.delaySeconds ?? options?.delaySeconds }),
                );

                messages.push(...sent);

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
                throw new LunoraError("INTERNAL", `harness.queues.sent("${queue}"): no such queue — declared: ${[...declared].join(", ") || "(none)"}`);
            }

            return messages.filter((message) => message.queue === queue);
        },
    };

    return { controls, surfaces: { queues } };
};

/**
 * The recording `ctx.queues` for `names`; without the option, a stub that throws
 * naming it — and a `sent()` that throws too, so a handler swallowing the stub's
 * error cannot make "nothing was enqueued" pass vacuously.
 */
const createFakeQueues = (names: ReadonlyArray<string> | undefined): { controls: FakeQueueControls; surfaces: QueueSurface } => {
    if (names !== undefined) {
        return createRecordingQueues(names);
    }

    return {
        controls: { clear: () => unavailable("queues", OPTION), sent: () => unavailable("queues", OPTION) },
        surfaces: { queues: stubProxy("queues", OPTION) as Queues },
    };
};

export type { FakeQueueControls, QueueSurface, SentQueueMessage };
export { createFakeQueues };
