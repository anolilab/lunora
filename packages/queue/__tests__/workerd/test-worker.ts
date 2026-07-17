/**
 * Test entry-point Worker for `@lunora/queue` workerd integration tests.
 *
 * Mirrors what codegen emits for a project with one `defineQueue` export: a
 * typed push handler registered by its stable wrangler queue name, and a worker
 * `queue()` entry that routes every delivered `MessageBatch` through
 * `dispatchQueueBatch` — exactly the production consumer path.
 */
import { defineQueue, queueDefaultName } from "../../src/define-queue";
import type { QueueRegistry } from "../../src/dispatch";
import { dispatchQueueBatch } from "../../src/dispatch";

interface SmokeBody {
    text: string;
}

interface Env {
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
const smokeQueue = defineQueue<SmokeBody>({
    handler: (_context, batch) => {
        for (const message of batch.messages) {
            deliveries.push({ attempts: message.attempts, body: message.body, id: message.id, queue: batch.queue });
            message.ack();
        }

        return Promise.resolve();
    },
});

/** Stable wrangler queue name → registry entry, exactly as codegen builds it. */
const registry: QueueRegistry = {
    [queueDefaultName("smokeQueue")]: { definition: smokeQueue, exportName: "smokeQueue" },
};

const testWorker = {
    fetch(_request: Request, _env: Env): Response {
        return new Response("queue-test-worker", { status: 200 });
    },
    async queue(batch: MessageBatch<SmokeBody>, env: Env): Promise<void> {
        // The generated worker `queue()` entry: route the real workerd batch
        // through the production dispatcher.
        await dispatchQueueBatch(batch, registry, { env: env as unknown as Record<string, unknown> });
    },
};

export default testWorker;
export { deliveries, registry, smokeQueue };
export type { DeliveredMessage, Env, SmokeBody };
