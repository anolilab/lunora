/**
 * The queue-shaped input the `queue_*` lints consume, produced by the codegen
 * feeder — one per `defineQueue` export in `lunora/queues.ts`. Runtime callers
 * don't supply it, so the queue lints simply find nothing there.
 *
 * A structural subset of codegen's `QueueIR`, so the feeder passes the IR array
 * straight through without conversion (mirrors how `AdvisorWorkflow` tracks
 * `WorkflowIR` and `AdvisorContainer` tracks `ContainerIR`).
 */

/**
 * The push-consumer batch/retry tuning a queue lint inspects — the subset of
 * `QueueIR["tuning"]` mirrored onto the wrangler `queues.consumers[]` entry.
 */
export interface AdvisorQueueTuning {
    /**
     * The wrangler name of the dead-letter queue exhausted messages are routed
     * to. `undefined` when none is declared — a message that exhausts its
     * retries is then dropped and permanently lost.
     */
    deadLetterQueue?: string;
    /** Max delivery retries before a message is dead-lettered/dropped (Cloudflare default 3). */
    maxRetries?: number;
}

/** One queue declared via a `defineQueue()` export in `lunora/queues.ts`. */
export interface AdvisorQueue {
    /** The `lunora/queues.ts` export name, e.g. `notifications`. */
    exportName: string;
    /** How the queue is consumed: `"push"` (a worker `queue()` handler) or `"pull"` (external HTTP). */
    mode: "pull" | "push";

    /**
     * The stable wrangler queue name (kebab-cased export name unless a `name:`
     * literal overrides it). Used to recognise a queue that is itself another
     * queue's `deadLetterQueue` target — a terminal sink that must not be
     * flagged for lacking its own DLQ.
     */
    name: string;
    /** Push-consumer batch/retry tuning; the `deadLetterQueue`/`maxRetries` the queue lints read. */
    tuning: AdvisorQueueTuning;
}
