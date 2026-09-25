/**
 * Test entry-point Worker for `@lunora/queue` workerd integration tests.
 *
 * Mirrors what codegen emits for a project with one `defineQueue` export: a
 * typed push handler registered by its stable wrangler queue name, and a worker
 * `queue()` entry that routes every delivered `MessageBatch` through
 * `dispatchQueueBatch` — exactly the production consumer path.
 */
import { LunoraError, toErrorBody } from "@lunora/errors";

import { defineQueue, queueDefaultName } from "../../src/define-queue";
import type { QueueRegistry } from "../../src/dispatch";
import { dispatchQueueBatch } from "../../src/dispatch";
import type { QueueDefinition } from "../../src/types";

interface SmokeBody {
    text: string;
}

interface Env {
    QUEUE_DECLINE_QUEUE: Queue<SmokeBody>;
    QUEUE_SMOKE_QUEUE: Queue<SmokeBody>;
}

/** One message as observed by the push handler (for test assertions). */
interface DeliveredMessage {
    attempts: number;
    body: SmokeBody;
    id: string;
    queue: string;
}

/**
 * Messages the push handler consumed. The pool runs the main worker in the same
 * isolate + module graph as the tests, so tests can import and inspect this
 * directly after a delivery.
 */
const deliveries: DeliveredMessage[] = [];

/** The `lunora/queues.ts`-style export under test. */
const smokeQueue: QueueDefinition<SmokeBody> = defineQueue<SmokeBody>({
    handler: (_context, batch) => {
        for (const message of batch.messages) {
            deliveries.push({ attempts: message.attempts, body: message.body, id: message.id, queue: batch.queue });
            message.ack();
        }

        return Promise.resolve();
    },
});

/** Every delivery of a `decline-queue` message the handler saw, with the broker's own attempt count and the body it read. */
const declineDeliveries: { attempts: number; body: SmokeBody; id: string }[] = [];

/**
 * The `decline-queue` dispatch origin: declines while `remaining` is above
 * zero (forever by default), and records the dedup id of every call it saw.
 */
const declineOrigin = { dedupIds: [] as string[], remaining: Number.POSITIVE_INFINITY };

/** Every copy the consumer re-enqueued onto `decline-queue`, as sent. */
const requeuedSends: { body: unknown; options: unknown }[] = [];

/**
 * A push handler that dispatches through `message.run`, whose dispatch hop is
 * answered by {@link declineFetch} with exactly what a shard answers a
 * re-delivery whose first attempt is still running: `409 DISPATCH_IN_PROGRESS`.
 */
const declineQueue: QueueDefinition<SmokeBody> = defineQueue<SmokeBody>({
    handler: async (_context, batch) => {
        for (const message of batch.messages) {
            declineDeliveries.push({ attempts: message.attempts, body: message.body, id: message.id });

            // eslint-disable-next-line no-await-in-loop -- one message per batch here; sequential like a real handler
            await message.run({ __lunoraRef: "orders:slowAction" });
        }
    },
    maxRetries: 2,
});

/** The dispatch hop for `decline-queue`: a call is declined the way `ShardDO` declines it, see {@link declineOrigin}. */
const declineFetch = async (_url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const { id } = JSON.parse(init?.body as string) as { id?: string };

    declineOrigin.dedupIds.push(String(id));

    if (declineOrigin.remaining <= 0) {
        return Response.json({ result: "done" });
    }

    declineOrigin.remaining -= 1;

    const { body, status } = toErrorBody(new LunoraError("DISPATCH_IN_PROGRESS", "a dispatch carrying this idempotency id is already running"));

    // The header only the shard's claim path sets — what makes this a decline and not a handler error.
    return Response.json({ error: body }, { headers: { "x-lunora-dispatch-declined": "1" }, status });
};

/** Stable wrangler queue name → registry entry, exactly as codegen builds it. */
const registry: QueueRegistry = {
    [queueDefaultName("declineQueue")]: { binding: "QUEUE_DECLINE_QUEUE", definition: declineQueue, exportName: "declineQueue" },
    [queueDefaultName("smokeQueue")]: { definition: smokeQueue, exportName: "smokeQueue" },
};

const testWorker = {
    fetch(_request: Request, _env: Env): Response {
        return new Response("queue-test-worker", { status: 200 });
    },
    async queue(batch: MessageBatch<SmokeBody>, env: Env): Promise<void> {
        // The generated worker `queue()` entry: route the real workerd batch
        // through the production dispatcher.
        // Every dispatch here is declined: `smokeQueue` makes none, so only
        // `declineQueue` ever reaches `declineFetch`.
        // The real `decline-queue` producer, recording what the consumer re-enqueues onto it.
        const declineProducer = {
            send: async (body: SmokeBody, options?: QueueSendOptions): Promise<void> => {
                requeuedSends.push({ body, options });
                await env.QUEUE_DECLINE_QUEUE.send(body, options);
            },
        };

        await dispatchQueueBatch(batch, registry, {
            env: { ...env, LUNORA_ADMIN_TOKEN: "test-token", LUNORA_ORIGIN_URL: "https://origin.test", QUEUE_DECLINE_QUEUE: declineProducer },
            fetchImpl: declineFetch,
        });
    },
};

export default testWorker;
export { declineDeliveries, declineOrigin, deliveries, registry, requeuedSends, smokeQueue };
export type { DeliveredMessage, Env, SmokeBody };
