/**
 * Recording `ctx.queues` / `ctx.topics` for the `lunoraTest` harness. Each name a
 * handler reaches for gets the real `@lunora/queue` producer/publisher (so the
 * delay ceiling, batch cap and reserved-key checks reject exactly as in
 * production) over a binding that records instead of sending.
 */
import type { MessageSendRequestLike, QueueBindingLike, Queues, Topics } from "@lunora/queue";
import { createQueues, createTopicContext } from "@lunora/queue";

/** One message a handler enqueued: its body plus the per-message (or batch) `contentType` / `delaySeconds`. */
type RecordedQueueMessage = MessageSendRequestLike;

/** Harness controls for the recorded `ctx.queues` sends. */
interface FakeQueueControls {
    /** Every message sent to `ctx.queues.<name>` (via `send` or `sendBatch`), in send order. */
    sent: (name: string) => RecordedQueueMessage[];
}

/** Harness controls for the recorded `ctx.topics` publishes. */
interface FakeTopicControls {
    /** Every message published to `ctx.topics.<name>` (via `publish` or `publishBatch`), in publish order. */
    published: (name: string) => RecordedQueueMessage[];
}

/** A binding that appends what it is handed to `log`; a batch's own `delaySeconds` loses to a message's. */
const recordingBinding = (log: RecordedQueueMessage[]): QueueBindingLike => {
    return {
        send: (body, options) => {
            log.push({ ...options, body });

            return Promise.resolve();
        },
        sendBatch: (messages, options) => {
            for (const message of messages) {
                log.push({ ...options, ...message });
            }

            return Promise.resolve();
        },
    };
};

/**
 * A name → value map that builds each entry on first read over its own recording
 * log. Open-ended: the harness has no codegen specs, so any name a handler uses
 * is accepted. Non-string keys (symbols read by inspection) and `then` (read by
 * `await`) are not names.
 */
const recordingLookup = <T>(build: (binding: QueueBindingLike) => T): { logs: Map<string, RecordedQueueMessage[]>; lookup: Record<string, T> } => {
    const logs = new Map<string, RecordedQueueMessage[]>();
    const built = new Map<string, T>();

    const lookup = new Proxy<Record<string, T>>(
        {},
        {
            get(_target, property): T | undefined {
                if (typeof property !== "string" || property === "then") {
                    return undefined;
                }

                let value = built.get(property);

                if (value === undefined) {
                    const log: RecordedQueueMessage[] = [];

                    logs.set(property, log);
                    value = build(recordingBinding(log));
                    built.set(property, value);
                }

                return value;
            },
        },
    );

    return { logs, lookup };
};

/** Build the recording `ctx.queues` and its `harness.queues` controls. */
const createFakeQueues = (): { controls: FakeQueueControls; queues: Queues } => {
    const { logs, lookup } = recordingLookup((binding) => createQueues({ bindings: { queue: binding } }).queue);

    return { controls: { sent: (name) => [...(logs.get(name) ?? [])] }, queues: lookup };
};

/** Build the recording `ctx.topics` (one subscription per topic) and its `harness.topics` controls. */
const createFakeTopics = (): { controls: FakeTopicControls; topics: Topics } => {
    const { logs, lookup } = recordingLookup(
        (binding) => createTopicContext({ FAKE: binding }, [{ exportName: "topic", subscriptions: [{ binding: "FAKE", exportName: "subscription" }] }]).topic,
    );

    return { controls: { published: (name) => [...(logs.get(name) ?? [])] }, topics: lookup };
};

export type { FakeQueueControls, FakeTopicControls, RecordedQueueMessage };
export { createFakeQueues, createFakeTopics };
