/** The `wrangler.jsonc` shape the validator reads, and the report it returns. */

interface WranglerDurableObjectBinding {
    class_name?: string;
    name?: string;
    /** Present when the class lives in ANOTHER Worker — then it is that script's to export, not this entry's. */
    script_name?: string;
}

/**
 * A `tail_consumers` entry: a Worker that receives this Worker's tail events
 * (logs, exceptions, fetch metadata) for forwarding to an external sink. See
 * `withTailConsumer` for the wiring helper.
 */
interface TailConsumer {
    /** Optional Cloudflare environment of the consumer Worker. */
    environment?: string;
    /** Name of the Worker that consumes tail events. */
    service?: string;
}

/**
 * `observability.traces` — Workers Traces. `destinations` names OpenTelemetry
 * export destinations configured in the dashboard; `persist: false` exports
 * without also storing in Cloudflare (default `true`).
 * https://developers.cloudflare.com/workers/observability/opentelemetry-export/
 */
interface WranglerObservabilityTraces {
    destinations?: ReadonlyArray<string>;
    enabled?: boolean;
    /** Fraction of requests traced, 0–1. */
    head_sampling_rate?: number;
    persist?: boolean;
}

/**
 * `observability.logs` — Workers Logs. Same export knobs as traces, plus
 * `invocation_logs` (the per-invocation summary line; default `true`).
 */
interface WranglerObservabilityLogs extends WranglerObservabilityTraces {
    invocation_logs?: boolean;
}

/** The wrangler `observability` block (Workers Logs + Traces). */
interface WranglerObservability {
    enabled?: boolean;
    /** Fraction of requests logged, 0–1 (wrangler's default is 1: every request). */
    head_sampling_rate?: number;
    /** Workers Issues — detects and groups production failures. */
    issues?: { enabled?: boolean };
    logs?: WranglerObservabilityLogs;
    traces?: WranglerObservabilityTraces;
}

/** A wrangler `containers[]` entry (parsed from untrusted JSONC). */
interface WranglerContainerEntry {
    class_name?: string;
    image?: string;
    /** Named images under the `durable_object` scheduling policy. */
    images?: Record<string, { build_context?: string; build_vars?: Record<string, string>; dockerfile?: string; image?: string } | null | undefined>;
    instance_type?: string | { disk_mb?: number; memory_mib?: number; vcpu?: number };
    max_instances?: number;
    scheduling_policy?: string;
}

/**
 * A wrangler `workflows[]` entry (parsed from untrusted JSONC). Unlike
 * containers, workflows are NOT Durable Objects — the entry stands alone (no
 * `durable_objects` binding, no migration class).
 */
interface WranglerWorkflowEntry {
    binding?: string;
    class_name?: string;
    /** `{ success_retention?, error_retention? }` durations; shape-checked by `validateWorkflowSettings`. */
    default_retention?: unknown;
    /** `{ steps? }`; shape-checked by `validateWorkflowSettings`. */
    limits?: unknown;
    name?: string;
    /** Cron strings that each start an instance; shape-checked by `validateWorkflowSettings`. */
    schedules?: unknown;
    /** Present when the class lives in ANOTHER Worker — then it is that script's to export. */
    script_name?: string;
}

/** A wrangler `queues.producers[]` entry — a `Queue` binding sending to `queue`. */
interface WranglerQueueProducer {
    binding?: string;
    delivery_delay?: number;
    queue?: string;
}

/** A wrangler `queues.consumers[]` entry — push (worker) or `type: "http_pull"`. */
interface WranglerQueueConsumer {
    dead_letter_queue?: string;
    max_batch_size?: number;
    max_batch_timeout?: number;
    max_retries?: number;
    queue?: string;
    retry_delay?: number;
    type?: string;
}

interface WranglerConfig {
    // Workers AI binding (`env.AI`). Self-describing { binding }; parsed from
    // untrusted JSONC, so it may be `null`.
    ai?: { binding?: unknown } | null;
    // AI Search single-instance bindings (`{ binding, instance_name }`). The
    // instance must already exist at deploy time; only the shape is checked.
    ai_search?: ReadonlyArray<{ binding?: string; instance_name?: string; remote?: boolean } | null | undefined>;
    // AI Search namespace bindings (`{ binding, namespace }`) — what `ctx.aiSearch`
    // reads. Wrangler creates a missing namespace on deploy.
    ai_search_namespaces?: ReadonlyArray<{ binding?: string; namespace?: string; remote?: boolean } | null | undefined>;
    // Analytics SQL binding (`env.ANALYTICS_SQL`, wrangler >= 4.145.0) — what
    // `ctx.analyticsSql` reads. Self-describing { binding, remote? }; parsed from
    // untrusted JSONC, so it may be `null`. Not `analytics_engine_datasets`.
    analytics?: { binding?: unknown; remote?: boolean } | null;
    // Analytics Engine datasets (self-describing: { binding, dataset }, dataset
    // defaults to the binding name). See `validateAnalyticsBindings`.
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string } | null | undefined>;
    // Artifacts (Git-compatible versioned storage) bindings. The `namespace` is
    // created out-of-band, so only the `{ binding, namespace }` shape is checked.
    artifacts?: ReadonlyArray<{ binding?: string; namespace?: string; remote?: boolean } | null | undefined>;
    // Workers Static Assets (serves the client build alongside the worker). NOT
    // Cloudflare Pages (an explicit non-goal). See `validateAssets`.
    assets?: { binding?: string; directory?: string; html_handling?: string; not_found_handling?: string };
    // Browser Rendering binding (`env.BROWSER`). Self-describing { binding }.
    browser?: { binding?: string };
    // Workers Cache toggle (`"cache": { "enabled": true }`). Parsed from
    // untrusted JSONC, so it may be `null` or malformed; `validateCache` guards
    // against that at runtime.
    cache?: { enabled?: boolean } | null;
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; `validateContainers` guards against that at runtime.
    containers?: ReadonlyArray<WranglerContainerEntry | null | undefined>;
    // The `database_id` / `database_name` are remote resources Lunora can't mint
    // (`wrangler d1 create`) — `validateD1Databases` checks the shape (binding +
    // at least one of the two) only. `migrations_pattern` is a glob relative to
    // the config file (wrangler defaults it to `${migrations_dir}/*.sql`).
    d1_databases?: ReadonlyArray<
        { binding?: string; database_id?: string; database_name?: string; migrations_dir?: string; migrations_pattern?: string } | null | undefined
    >;
    // Workers for Platforms dispatch namespaces — passthrough/shape-check only
    // (the `outbound` shape is deep WfP territory Lunora does not police). See
    // `validateDispatchNamespaces`.
    dispatch_namespaces?: ReadonlyArray<{ binding?: string; namespace?: string; outbound?: unknown } | null | undefined>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    // Per-environment overrides (`env.<name>` in wrangler.jsonc). Which keys a
    // declared environment inherits from the top level vs must redeclare is
    // NOT uniform — see `NON_INHERITABLE_KEYS` / `INHERITABLE_KEYS` /
    // `mergeWranglerEnvironment`. Recursive by the same shape (minus its own
    // `env`, which wrangler does not support nesting).
    env?: Record<string, WranglerConfig>;
    // Per-entrypoint cache control for named `WorkerEntrypoint`s. Lunora apps
    // typically use a single `export default` entrypoint, so this is passthrough.
    // Parsed from untrusted JSONC, so the map or any entry may be `null`;
    // `validateExports` guards against that at runtime.
    // A `type: "workflow"` entry declares a Workflow this Worker defines (keyed
    // by class name) with the same settings a `workflows[]` binding takes; see
    // `validateWorkflowSettings`.
    exports?: Record<
        string,
        { cache?: { enabled?: boolean } | null; default_retention?: unknown; limits?: unknown; name?: unknown; schedules?: unknown; type?: string } | null
    > | null;
    // Cloudflare Flagship feature-flag bindings (`@lunora/flags` binding mode).
    // The `app_id` is a remote Flagship app Lunora can't mint — warn, don't fail.
    // See `HINT_BINDING_RULES`.
    flagship?: ReadonlyArray<{ app_id?: string; binding?: string } | null | undefined>;
    // Hyperdrive (bring-your-own Postgres/MySQL). The `id` is a remote resource
    // (`wrangler hyperdrive create`) Lunora can't mint — warn, don't fail. See
    // `validateHyperdriveBindings`.
    hyperdrive?: ReadonlyArray<{ binding?: string; id?: string; localConnectionString?: string } | null | undefined>;
    // Cloudflare Images binding (`env.IMAGES`). Self-describing { binding }.
    images?: { binding?: string };
    // Workers KV namespaces. The namespace `id` is a remote resource Lunora
    // can't mint — warn, don't fail. See `validateKvNamespaces`.
    kv_namespaces?: ReadonlyArray<{ binding?: string; id?: string } | null | undefined>;
    // Per-Worker runtime caps. `cpu_ms` bounds the blast radius of a runaway
    // handler — detection is lagging by definition, so the cap is what actually
    // limits the bill while an alert is still being written. See `validateLimits`.
    limits?: { cpu_ms?: number };
    // Cloudflare Logpush toggle (jobs are created out-of-band via dashboard/API).
    logpush?: boolean;
    // The worker entry, relative to the config file. Read to check that every
    // declared Durable Object / Workflow class is actually exported by it.
    main?: string;
    // Media Transformations binding (`env.MEDIA`). Self-describing { binding }.
    media?: { binding?: string };
    // Durable Object class history wrangler applies IN ORDER to compute which
    // classes currently exist — a class can be added, renamed, and/or deleted
    // across several entries over a project's lifetime. See
    // `foldMigrationClasses`, which is the only code that should read the
    // `renamed_classes` / `deleted_classes` shape below.
    migrations?: ReadonlyArray<
        | {
              deleted_classes?: ReadonlyArray<string>;
              new_classes?: ReadonlyArray<string>;
              new_sqlite_classes?: ReadonlyArray<string>;
              renamed_classes?: ReadonlyArray<{ from?: string; to?: string } | null | undefined>;
          }
        | null
        | undefined
    >;
    // mTLS client-certificate bindings (`Fetcher` that presents a client cert on
    // outbound fetch). Cert material lives in Cloudflare, referenced by id. See
    // `validateMtlsCertificates`.
    mtls_certificates?: ReadonlyArray<{ binding?: string; certificate_id?: string } | null | undefined>;
    observability?: WranglerObservability;
    // Pipelines (R2-backed streaming ingestion). The `pipeline` name is a remote
    // resource (`wrangler pipelines create`) Lunora can't mint — warn, don't
    // fail. See `validatePipelineBindings`.
    pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string; stream?: string } | null | undefined>;
    // Smart Placement (`{ mode: "smart" }` — the only documented mode). See
    // `validatePlacement`.
    placement?: { host?: string; hostname?: string; mode?: string; region?: string };
    // Cloudflare Queues — producer bindings (`env.<BINDING>.send(...)`) and
    // push/pull consumers. Lunora reconciles both from `lunora/queues.ts`; the
    // entries are parsed from untrusted JSONC, so `validateQueues` guards shape.
    queues?: {
        consumers?: ReadonlyArray<WranglerQueueConsumer | null | undefined>;
        producers?: ReadonlyArray<WranglerQueueProducer | null | undefined>;
    };
    // Structural only (`validateR2Buckets`): a declared bucket needs a
    // `bucket_name` — the remote bucket itself (`wrangler r2 bucket create`) is
    // out of scope for a pure validator. `bucket_name` is the remote bucket the
    // binding points at, projected here (wrangler has always required it) so a
    // consumer can name the real bucket in a diagnostic instead of the binding
    // alias. Entries stay nullable: the shared array validator reports a
    // non-object entry itself, so narrowing here would only move the failure.
    // `jurisdiction` addresses a bucket created inside a data-residency
    // jurisdiction (`wrangler r2 bucket create --jurisdiction`).
    r2_buckets?: ReadonlyArray<{ binding?: string; bucket_name?: string; jurisdiction?: string } | null | undefined>;
    // The secret names the Worker requires (`wrangler dev` loads only these from
    // `.dev.vars`; `wrangler deploy` fails while one is unset). Untrusted JSONC,
    // so `validateSecretsRequired` checks it is a list of names.
    secrets?: { required?: unknown } | null;
    // Cloudflare Secrets Store bindings (`env.<BINDING>.get()`). Each references a
    // remote store + secret by name (created out-of-band); `validateSecretsStore`
    // shape-checks the entries. See also the `ctx.secrets` core built-in.
    secrets_store_secrets?: ReadonlyArray<{ binding?: string; secret_name?: string; store_id?: string } | null | undefined>;
    // Email Routing outbound bindings used for auto-reply/forward from an
    // inbound `email()` worker (plan 029). Shape-check only. See
    // `validateSendEmail`.
    send_email?: ReadonlyArray<{ allowed_destination_addresses?: ReadonlyArray<string>; destination_address?: string; name?: string } | null | undefined>;
    // Service bindings (worker-to-worker RPC / fetch). The `service` target is
    // an external worker Lunora can't discover — validate shape only, hint-only
    // inference (the binding name is user-supplied). See `validateServices`.
    services?: ReadonlyArray<{ binding?: string; entrypoint?: string; environment?: string; service?: string } | null | undefined>;
    // Stream (video library) binding (`env.STREAM`). Self-describing { binding }.
    stream?: { binding?: string };
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; the validators below guard against that at runtime.
    tail_consumers?: ReadonlyArray<TailConsumer | null | undefined>;
    // Plain-text environment variables (`env.*`). Lunora reads a handful of
    // `LUNORA_*` security knobs from here; `validateCorsVariables` flags an unsafe
    // CORS combination. Values are untrusted JSONC, so non-string entries are
    // tolerated and ignored.
    vars?: Record<string, unknown>;
    vectorize?: ReadonlyArray<{ binding?: string; index_name?: string } | null | undefined>;
    // Workers VPC Network bindings: a Cloudflare Tunnel (`tunnel_id`) or the
    // Cloudflare Mesh network (`network_id: "cf1:network"`) — exactly one. See
    // `validateVpcNetworks`.
    vpc_networks?: ReadonlyArray<{ binding?: string; network_id?: string; remote?: boolean; tunnel_id?: string } | null | undefined>;
    // Workers VPC Service bindings: one host + port, referenced by `service_id`
    // (created out-of-band). Shape-check only.
    vpc_services?: ReadonlyArray<{ binding?: string; remote?: boolean; service_id?: string } | null | undefined>;
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; `validateWorkflows` guards against that at runtime.
    workflows?: ReadonlyArray<WranglerWorkflowEntry | null | undefined>;
}

interface WranglerValidationReport {
    errors: string[];
    valid: boolean;
    warnings: string[];
}

export type {
    TailConsumer,
    WranglerConfig,
    WranglerContainerEntry,
    WranglerObservability,
    WranglerObservabilityLogs,
    WranglerObservabilityTraces,
    WranglerValidationReport,
    WranglerWorkflowEntry,
};
