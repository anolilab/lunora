/** The slice of `wrangler.jsonc` the binding reconciler reads and rewrites, and the step each reconcile returns. */

interface DurableObjectBinding {
    class_name?: string;
    name?: string;
}

/**
 * One `migrations[]` record as READ BACK from a hand-edited `wrangler.jsonc` —
 * so every list may hold a `null` (a trailing comma in a JSONC array parses to
 * one). The nullability is in the type on purpose: it was absent, the replay
 * below trusted it, and a stray `null` threw a raw `TypeError` out of a step
 * that runs on every dev-server start.
 */
interface MigrationEntry {
    deleted_classes?: ReadonlyArray<string | null | undefined>;
    new_classes?: ReadonlyArray<string | null | undefined>;
    new_sqlite_classes?: ReadonlyArray<string | null | undefined>;
    renamed_classes?: ReadonlyArray<{ from?: string; to?: string } | null | undefined>;
    tag?: string;
}

interface ContainerEntry {
    class_name?: string;
}

interface WorkflowEntry {
    binding?: string;
    class_name?: string;
    default_retention?: unknown;
    limits?: unknown;
    name?: string;
    schedules?: unknown;
    script_name?: string;
}

interface QueueProducerEntry {
    binding?: string;
    queue?: string;
}

interface QueueConsumerEntry {
    dead_letter_queue?: string;
    max_batch_size?: number;
    max_batch_timeout?: number;
    max_retries?: number;
    queue?: string;
    retry_delay?: number;
    type?: string;
}

interface QueuesShape {
    consumers?: ReadonlyArray<QueueConsumerEntry>;
    producers?: ReadonlyArray<QueueProducerEntry>;
}

interface WranglerShape {
    ai?: { binding?: string };
    // Self-describing: { binding, dataset } with no remote id — auto-writeable (see reconcileAnalytics).
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string }>;
    // Self-describing: a parameterless { binding } — auto-writeable like `ai` (see reconcileBrowser).
    browser?: { binding?: string };
    containers?: ReadonlyArray<ContainerEntry>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<DurableObjectBinding> };
    // Presence-only: read here just to tell whether a requested `--env <name>`
    // is declared at all, for the advisory warning below. Never written into.
    env?: Record<string, unknown>;
    // Hint-only: the `app_id` is a remote Flagship app Lunora can't mint — warned, never written.
    flagship?: ReadonlyArray<{ app_id?: string; binding?: string }>;
    // Hint-only: the `id` is a remote Hyperdrive resource Lunora can't mint — warned, never written.
    hyperdrive?: ReadonlyArray<{ binding?: string; id?: string }>;
    // Self-describing: a parameterless { binding } — auto-writeable like `ai` (see reconcileImages).
    images?: { binding?: string };
    // Hint-only: the namespace `id` is a remote KV resource Lunora can't mint — warned, never written.
    kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string }>;
    migrations?: ReadonlyArray<MigrationEntry | null | undefined>;
    name?: string;
    observability?: { enabled?: boolean; head_sampling_rate?: number; logs?: { enabled?: boolean; head_sampling_rate?: number } };
    // Hint-only: the `pipeline` name is a remote resource Lunora can't mint — warned, never written.
    pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string; stream?: string }>;
    // Cloudflare Queues — producers + consumers, both reconciled from `lunora/queues.ts`.
    queues?: QueuesShape;
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
    // Self-describing: `[{ binding }]` with nothing remote to mint (see reconcileWorkerLoaders).
    worker_loaders?: ReadonlyArray<{ binding?: string }>;
    workflows?: ReadonlyArray<WorkflowEntry>;
}

interface ReconcileStep {
    added: string[];
    text: string;
    /** Existing entries rewritten in place; see `ReconcileBindingsResult.updated` (`reconcile-bindings.ts`). */
    updated?: string[];
    /** Non-fatal notes about this step, folded into `ReconcileBindingsResult.warnings`. */
    warnings?: string[];
}

export type { MigrationEntry, QueueConsumerEntry, QueuesShape, ReconcileStep, WranglerShape };
