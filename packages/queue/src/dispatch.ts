/**
 * `dispatchQueueBatch` — routes a delivered `MessageBatch` to the matching
 * `defineQueue` push handler and runs it inside a Lunora queue context. The
 * generated worker `queue()` entry (wired by codegen into `createWorker`) calls
 * this with the project's queue registry. Node-safe so it's unit-testable with
 * plain-object batches.
 */
import { LunoraError } from "@lunora/errors";

import { createQueueRunContext } from "./run-context";
import type { MessageBatchLike, QueueDefinition } from "./types";

/** One declared queue, keyed for batch routing by its stable wrangler name. */
interface QueueRegistryEntry {
    /**
     * The `defineQueue` result (carries the push handler). The body type is
     * erased to `any` here because the registry is heterogeneous — different
     * queues carry different message bodies, and the handler param is
     * contravariant, so a precise `QueueDefinition&lt;Body>` would not be assignable
     * to a shared `unknown`-bodied slot. Runtime dispatch passes the delivered
     * batch straight through, so the erasure is type-only.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous registry; see doc above
    definition: QueueDefinition<any>;
    /** The `lunora/queues.ts` export name, for log correlation. */
    exportName: string;
}

/** Map of stable wrangler queue name → registry entry, built by codegen. */
type QueueRegistry = Record<string, QueueRegistryEntry>;

interface DispatchOptions {
    /** Worker `env`, forwarded to the queue run context. */
    env: Record<string, unknown>;
    /** Injectable fetch for the `ctx.run` dispatcher (tests). */
    fetchImpl?: typeof fetch;
}

/**
 * Look up the handler for `batch.queue` and invoke it with a fresh
 * `QueueRunContext`. Throws a directed error when no push handler is registered
 * for the delivered queue (a misconfiguration — the consumer was declared
 * `pull`, or the queue name drifted from the `defineQueue` export).
 */
const dispatchQueueBatch = async (batch: MessageBatchLike, registry: QueueRegistry, options: DispatchOptions): Promise<void> => {
    const entry = registry[batch.queue];

    if (entry === undefined) {
        const known = Object.keys(registry);
        const suffix = known.length === 0 ? "no push queues are declared" : `known push queues: ${known.join(", ")}`;

        throw new LunoraError("INTERNAL", `@lunora/queue: received a batch for queue "${batch.queue}" but no push handler is registered (${suffix})`);
    }

    const { handler } = entry.definition;

    if (typeof handler !== "function") {
        throw new TypeError(`@lunora/queue: queue "${batch.queue}" (${entry.exportName}) has no push handler — it is declared as a pull consumer`);
    }

    const context = createQueueRunContext({ env: options.env, exportName: entry.exportName, fetchImpl: options.fetchImpl });

    await handler(context, batch);
};

export type { QueueRegistry, QueueRegistryEntry };
export { dispatchQueueBatch };
