/**
 * The recording `ctx.queues` the `lunoraTest` harness hands mutation and action
 * contexts. Each declared queue gets a recording producer binding, wrapped in
 * `@lunora/queue`'s own `createQueues` — so the batch cap, the delay ceiling and
 * the reserved-key check reject in a test exactly as they do in production, and
 * an undeclared name rejects naming the declared ones. Each body is recorded as
 * the consumer would decode it: encoded with its content type (Cloudflare's
 * default `json` unless the message names one) and decoded back, so a `Date`
 * arrives as its ISO string, a `BigInt` or a cycle rejects, and a body mutated
 * after sending does not rewrite the record. Encoded sizes are checked against
 * the platform's 128 KB message and 256 KB batch limits.
 *
 * The harness does not read a queue's configured content type (it lives in
 * wrangler config), so a queue set to `v8` or `text` in wrangler is recorded as
 * `json` unless the sending call names its own.
 */
import { deserialize, serialize } from "node:v8";

import { LunoraError } from "@lunora/errors";
import type { MessageSendRequestLike, QueueBindingLike, QueueContentType, Queues, QueueSendBatchOptions, QueueSendOptions } from "@lunora/queue";
import { createQueues } from "@lunora/queue";

import { stubProxy, unavailable } from "./context-fakes";

/** One message a handler enqueued through `ctx.queues.<name>`, as the consumer decodes it. */
interface SentQueueMessage {
    body: unknown;
    contentType?: QueueContentType;
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

/** Cloudflare Queues' per-message and per-batch body ceilings. `@lunora/queue` leaves them to the platform, so the harness, standing in for it, enforces them. */
const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_BATCH_BYTES = 256 * 1024;

/** Cloudflare's content type when a message names none. */
const DEFAULT_CONTENT_TYPE: QueueContentType = "json";

const encoder = new TextEncoder();

/**
 * Encode `body` the way the wire would, and decode it back: the record holds
 * what the consumer receives. Returns the decoded body and its encoded size.
 */
const wireFormOf = (body: unknown, contentType: QueueContentType): { body: unknown; bytes: number } => {
    if (contentType === "v8") {
        const encoded = serialize(body);

        return { body: deserialize(encoded), bytes: encoded.byteLength };
    }

    if (contentType === "text") {
        if (typeof body !== "string") {
            throw new LunoraError("VALIDATION_ERROR", `@lunora/queue: a "text" message body must be a string, got ${typeof body}`);
        }

        return { body, bytes: encoder.encode(body).byteLength };
    }

    if (contentType === "bytes") {
        if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
            throw new LunoraError("VALIDATION_ERROR", '@lunora/queue: a "bytes" message body must be an ArrayBuffer or an ArrayBufferView');
        }

        return { body, bytes: body.byteLength };
    }

    // `json`, the default. `JSON.stringify` returns `undefined` for a bare
    // `undefined` / function body, which the wire cannot carry at all.
    const text: unknown = JSON.stringify(body);

    if (typeof text !== "string") {
        throw new LunoraError("VALIDATION_ERROR", `@lunora/queue: a "json" message body must be JSON-serializable, got ${typeof body}`);
    }

    return { body: JSON.parse(text) as unknown, bytes: encoder.encode(text).byteLength };
};

const createRecordingQueues = (names: ReadonlyArray<string>): { controls: FakeQueueControls; surfaces: QueueSurface } => {
    const declared = new Set(names);
    const messages: SentQueueMessage[] = [];

    const encode = (queue: string, body: unknown, options: QueueSendOptions | undefined): { bytes: number; message: SentQueueMessage } => {
        const contentType = options?.contentType ?? DEFAULT_CONTENT_TYPE;
        const wire = wireFormOf(body, contentType);

        if (wire.bytes > MAX_MESSAGE_BYTES) {
            throw new LunoraError(
                "VALIDATION_ERROR",
                `@lunora/queue: ${queue} message is ${String(wire.bytes)} bytes, over the Cloudflare Queues limit of ${String(MAX_MESSAGE_BYTES)} (128 KB)`,
            );
        }

        return {
            bytes: wire.bytes,
            message: {
                body: wire.body,
                contentType,
                ...(options?.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }),
                queue,
            },
        };
    };

    const bindingFor = (queue: string): QueueBindingLike => {
        return {
            send: (body: unknown, options?: QueueSendOptions): Promise<void> => {
                messages.push(encode(queue, body, options).message);

                return Promise.resolve();
            },
            sendBatch: (batch: Iterable<MessageSendRequestLike>, options?: QueueSendBatchOptions): Promise<void> => {
                // A message's own delay wins over the batch's, as on Cloudflare. Encode the
                // whole batch before recording any of it, so one bad body records none.
                const encoded = [...batch].map((message) =>
                    encode(queue, message.body, { contentType: message.contentType, delaySeconds: message.delaySeconds ?? options?.delaySeconds }),
                );
                const total = encoded.reduce((sum, entry) => sum + entry.bytes, 0);

                if (total > MAX_BATCH_BYTES) {
                    throw new LunoraError(
                        "VALIDATION_ERROR",
                        `@lunora/queue: ${queue} batch is ${String(total)} bytes, over the Cloudflare Queues limit of ${String(MAX_BATCH_BYTES)} (256 KB)`,
                    );
                }

                messages.push(...encoded.map((entry) => entry.message));

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
