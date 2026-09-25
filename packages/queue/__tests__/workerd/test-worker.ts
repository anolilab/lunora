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

/** Every delivery of a `decline-queue` message the handler saw, with the broker's own attempt count. */
const declineDeliveries: { attempts: number; id: string }[] = [];

/**
 * A push handler that dispatches through `message.run`, whose dispatch hop is
 * answered by {@link declineFetch} with exactly what a shard answers a
 * re-delivery whose first attempt is still running: `409 DISPATCH_IN_PROGRESS`.
 */
const declineQueue: QueueDefinition<SmokeBody> = defineQueue<SmokeBody>({
    handler: async (_context, batch) => {
        for (const message of batch.messages) {
            declineDeliveries.push({ attempts: message.attempts, id: message.id });

            // eslint-disable-next-line no-await-in-loop -- one message per batch here; sequential like a real handler
            await message.run({ __lunoraRef: "orders:slowAction" });
        }
    },
    maxRetries: 2,
});

/** The dispatch hop for `decline-queue`: every call is declined the way `ShardDO` declines it. */
const declineFetch = (async () => {
    const { body, status } = toErrorBody(new LunoraError("DISPATCH_IN_PROGRESS", "a dispatch carrying this idempotency id is already running"));

    return Response.json({ error: body }, { status });
}) as unknown as typeof fetch;

/** Stable wrangler queue name → registry entry, exactly as codegen builds it. */
const registry: QueueRegistry = {
    [queueDefaultName("declineQueue")]: { definition: declineQueue, exportName: "declineQueue" },
    [queueDefaultName("smokeQueue")]: { definition: smokeQueue, exportName: "smokeQueue" },
};

const testWorker = {
    fetch(_request: Request, _env: Env): Response {
        return new Response("queue-test-worker", { status: 200 });
    },
    async queue(batch: MessageBatch<SmokeBody>, env: Env): Promise<void> {
        // The generated worker `queue()` entry: route the real workerd batch
        // through the production dispatcher.
        if (batch.queue === queueDefaultName("declineQueue")) {
            await dispatchQueueBatch(batch, registry, {
                env: { ...env, LUNORA_ADMIN_TOKEN: "test-token", LUNORA_ORIGIN_URL: "https://origin.test" },
                fetchImpl: declineFetch,
            });

            return;
        }

        await dispatchQueueBatch(batch, registry, { env: env as unknown as Record<string, unknown> });
    },
};

export default testWorker;
export { declineDeliveries, deliveries, registry, smokeQueue };
export type { DeliveredMessage, Env, SmokeBody };
