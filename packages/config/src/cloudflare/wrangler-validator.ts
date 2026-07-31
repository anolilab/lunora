/**
 * Shared wrangler.jsonc validator used by both the Vite plugin
 * (`@lunora/vite`) and the CLI (`@lunora/cli`).
 *
 * Two entry points are provided:
 * - `validateWranglerConfig(wrangler, schemaInfo)` — pure: takes a parsed
 * object plus an optional schema descriptor and returns a structured
 * `{ valid, errors, warnings }` result.
 * - `validateWranglerProject({ projectRoot, schemaDir })` — file-system
 * aware: locates `wrangler.jsonc`/`wrangler.json`, parses it, discovers
 * the project's schema, and returns the existing
 * `{ problems, wranglerPath }` shape kept for backward compatibility.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import join from "../path";
import type { SchemaInfo } from "../schema-info";
import { discoverSchemaInfo } from "../schema-info";
import { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "./workers-cache";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

const REQUIRED_COMPATIBILITY_DATE: string = "2026-04-07";

const REQUIRED_FLAG: string = "web_socket_auto_reply_to_close";

// Hoisted to module scope so the literal isn't re-compiled on every call.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

/** A wrangler `containers[]` entry (parsed from untrusted JSONC). */
interface WranglerContainerEntry {
    class_name?: string;
    image?: string;
    instance_type?: string | { disk_mb?: number; memory_mib?: number; vcpu?: number };
    max_instances?: number;
}

/**
 * A wrangler `workflows[]` entry (parsed from untrusted JSONC). Unlike
 * containers, workflows are NOT Durable Objects — the entry stands alone (no
 * `durable_objects` binding, no migration class).
 */
interface WranglerWorkflowEntry {
    binding?: string;
    class_name?: string;
    name?: string;
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
    // Analytics Engine datasets (self-describing: { binding, dataset }, dataset
    // defaults to the binding name). See `validateAnalyticsBindings`.
    analytics_engine_datasets?: ReadonlyArray<{ binding?: string; dataset?: string } | null | undefined>;
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
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    // Workers for Platforms dispatch namespaces — passthrough/shape-check only
    // (the `outbound` shape is deep WfP territory Lunora does not police). See
    // `validateDispatchNamespaces`.
    dispatch_namespaces?: ReadonlyArray<{ binding?: string; namespace?: string; outbound?: unknown } | null | undefined>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    // Per-entrypoint cache control for named `WorkerEntrypoint`s. Lunora apps
    // typically use a single `export default` entrypoint, so this is passthrough.
    // Parsed from untrusted JSONC, so the map or any entry may be `null`;
    // `validateExports` guards against that at runtime.
    exports?: Record<string, { cache?: { enabled?: boolean } | null; type?: string } | null> | null;
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
    // Cloudflare Logpush toggle (jobs are created out-of-band via dashboard/API).
    logpush?: boolean;
    // The worker entry, relative to the config file. Read to check that every
    // declared Durable Object / Workflow class is actually exported by it.
    main?: string;
    migrations?: ReadonlyArray<{ new_classes?: ReadonlyArray<string>; new_sqlite_classes?: ReadonlyArray<string> } | null | undefined>;
    // mTLS client-certificate bindings (`Fetcher` that presents a client cert on
    // outbound fetch). Cert material lives in Cloudflare, referenced by id. See
    // `validateMtlsCertificates`.
    mtls_certificates?: ReadonlyArray<{ binding?: string; certificate_id?: string } | null | undefined>;
    observability?: { enabled?: boolean; head_sampling_rate?: number; logs?: { enabled?: boolean; head_sampling_rate?: number } };
    // Pipelines (R2-backed streaming ingestion). The `pipeline` name is a remote
    // resource (`wrangler pipelines create`) Lunora can't mint — warn, don't
    // fail. See `validatePipelineBindings`.
    pipelines?: ReadonlyArray<{ binding?: string; pipeline?: string; stream?: string } | null | undefined>;
    // Smart Placement (`{ mode: "smart" }` — the only documented mode). See
    // `validatePlacement`.
    placement?: { mode?: string };
    // Cloudflare Queues — producer bindings (`env.<BINDING>.send(...)`) and
    // push/pull consumers. Lunora reconciles both from `lunora/queues.ts`; the
    // entries are parsed from untrusted JSONC, so `validateQueues` guards shape.
    queues?: {
        consumers?: ReadonlyArray<WranglerQueueConsumer | null | undefined>;
        producers?: ReadonlyArray<WranglerQueueProducer | null | undefined>;
    };
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
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
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; the validators below guard against that at runtime.
    tail_consumers?: ReadonlyArray<TailConsumer | null | undefined>;
    // Plain-text environment variables (`env.*`). Lunora reads a handful of
    // `LUNORA_*` security knobs from here; `validateCorsVariables` flags an unsafe
    // CORS combination. Values are untrusted JSONC, so non-string entries are
    // tolerated and ignored.
    vars?: Record<string, unknown>;
    vectorize?: ReadonlyArray<{ binding?: string; index_name?: string } | null | undefined>;
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; `validateWorkflows` guards against that at runtime.
    workflows?: ReadonlyArray<WranglerWorkflowEntry | null | undefined>;
}

interface WranglerValidationReport {
    errors: string[];
    valid: boolean;
    warnings: string[];
}

/**
 * Schema-declared vector indexes must each have a matching `vectorize` binding.
 * Extracted from {@link validateWranglerConfig} to keep its cognitive complexity
 * within bounds; pushes any mismatches onto the shared `errors` array.
 */
const validateVectorizeBindings = (wrangler: WranglerConfig, vectorIndexNames: ReadonlyArray<string>, errors: string[]): void => {
    if (vectorIndexNames.length === 0) {
        return;
    }

    const vectorizeBindings = wrangler.vectorize ?? [];
    const declaredIndexNames = new Set(vectorizeBindings.filter(Boolean).map((binding) => binding?.index_name));

    for (const indexName of vectorIndexNames) {
        if (!declaredIndexNames.has(indexName)) {
            errors.push(`schema declares vector index "${indexName}"; wrangler "vectorize" must include a binding with index_name "${indexName}"`);
        }
    }
};

/** Named instance types Cloudflare accepts (plus the legacy `dev`/`standard` aliases). */
const NAMED_INSTANCE_TYPES = new Set(["basic", "dev", "lite", "standard", "standard-1", "standard-2", "standard-3", "standard-4"]);

/** Documented bounds for custom instance types. */
const CUSTOM_INSTANCE_LIMITS = { disk_mb: 20_000, memory_mib: 12_288, vcpu: 4 } as const;

/** Validate one entry's `instance_type` (named or custom object). */
const validateInstanceType = (entry: WranglerContainerEntry, label: string, errors: string[]): void => {
    const instanceType = entry.instance_type;

    if (instanceType === undefined) {
        return;
    }

    if (typeof instanceType === "string") {
        if (!NAMED_INSTANCE_TYPES.has(instanceType)) {
            errors.push(
                `${label} has unknown instance_type "${instanceType}" — expected lite, basic, standard-1..4, or a custom { vcpu, memory_mib, disk_mb } object`,
            );
        }

        return;
    }

    for (const [field, limit] of Object.entries(CUSTOM_INSTANCE_LIMITS) as ReadonlyArray<[keyof typeof CUSTOM_INSTANCE_LIMITS, number]>) {
        const value = instanceType[field];

        if (value !== undefined && (typeof value !== "number" || value <= 0 || value > limit)) {
            errors.push(`${label} custom instance_type ${field} must be a positive number ≤ ${String(limit)} (got ${String(value)})`);
        }
    }

    const { disk_mb: diskMb, memory_mib: memoryMib, vcpu } = instanceType;

    if (typeof vcpu === "number" && typeof memoryMib === "number" && memoryMib < vcpu * 3072) {
        errors.push(`${label} custom instance_type needs ≥ 3 GiB (3072 MiB) memory per vCPU (got ${String(memoryMib)} MiB for ${String(vcpu)} vCPU)`);
    }

    if (typeof memoryMib === "number" && typeof diskMb === "number") {
        const maxDiskMb = Math.floor((memoryMib / 1024) * 2000);

        if (diskMb > maxDiskMb) {
            errors.push(
                `${label} custom instance_type allows ≤ 2 GB disk per GiB memory (≤ ${String(maxDiskMb)} MB for ${String(memoryMib)} MiB memory; got ${String(diskMb)} MB)`,
            );
        }
    }
};

/** Shared lookups + sinks for one `containers[]` entry validation pass. */
interface ContainerEntryChecks {
    boundClasses: ReadonlySet<string | undefined>;
    errors: string[];
    nonSqliteClasses: ReadonlySet<string>;
    sqliteClasses: ReadonlySet<string>;
    warnings: string[];
}

/**
 * Validate one `containers[]` entry: a `class_name` + `image`, a matching
 * `durable_objects` binding, and the class registered in a
 * `new_sqlite_classes` migration (containers require SQLite-backed DOs — a
 * `new_classes` registration deploys, then fails at runtime). Extracted from
 * {@link validateContainers} to keep its cognitive complexity bounded.
 */
const validateContainerEntry = (entry: WranglerContainerEntry | null | undefined, label: string, checks: ContainerEntryChecks): void => {
    const { boundClasses, errors, nonSqliteClasses, sqliteClasses, warnings } = checks;

    if (!entry || typeof entry !== "object" || typeof entry.class_name !== "string" || entry.class_name.length === 0) {
        errors.push(`${label} must have a non-empty "class_name" naming its container-enabled Durable Object class`);

        return;
    }

    if (typeof entry.image !== "string" || entry.image.length === 0) {
        errors.push(`${label} ("${entry.class_name}") must have an "image" — a Dockerfile path or a registry reference`);
    }

    if (!boundClasses.has(entry.class_name)) {
        errors.push(
            `${label} class "${entry.class_name}" has no matching durable_objects binding — run \`lunora dev\` to auto-reconcile wrangler.jsonc, or add { "name": "...", "class_name": "${entry.class_name}" }`,
        );
    }

    if (!sqliteClasses.has(entry.class_name)) {
        errors.push(
            nonSqliteClasses.has(entry.class_name)
                ? `${label} class "${entry.class_name}" is registered via "new_classes" but containers require SQLite-backed DOs — move it to "new_sqlite_classes"`
                : `${label} class "${entry.class_name}" is missing from migrations — add a migration entry with "new_sqlite_classes": ["${entry.class_name}"]`,
        );
    }

    validateInstanceType(entry, `${label} ("${entry.class_name}")`, errors);

    if (entry.max_instances === undefined) {
        warnings.push(`${label} ("${entry.class_name}") declares no max_instances — set a cap so a traffic spike can't fan out unbounded container spend`);
    }
};

/**
 * The object-typed entries of a possibly-malformed bindings array from untrusted
 * JSONC. Tolerates a non-array value (e.g. a stray string) and drops `null` /
 * non-object entries (a trailing comma in JSONC parses to `[null]`), so callers
 * can safely `.find`/`.map` string fields without a raw `TypeError`.
 */
const objectBindingEntries = <T>(value: ReadonlyArray<T> | undefined): T[] =>
    Array.isArray(value) ? value.filter((entry): entry is object & T => entry !== null && typeof entry === "object") : [];

/**
 * Every `containers[]` entry must be a container-enabled Durable Object the
 * worker actually wires up (see {@link validateContainerEntry}). Also nudges
 * when observability is off — container logs are invisible without it.
 */
const validateContainers = (wrangler: WranglerConfig, errors: string[], warnings: string[]): void => {
    if (wrangler.containers === undefined) {
        return;
    }

    if (!Array.isArray(wrangler.containers)) {
        errors.push("containers must be an array of { class_name, image, ... } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it so
    // member access below stays type-safe (mirrors `validateTailConsumers`).
    const entries = wrangler.containers as ReadonlyArray<WranglerContainerEntry | null | undefined>;

    if (entries.length === 0) {
        return;
    }

    const boundClasses = new Set(objectBindingEntries(wrangler.durable_objects?.bindings).map((binding) => binding.class_name));
    const migrations = wrangler.migrations ?? [];
    const sqliteClasses = new Set(migrations.flatMap((migration) => [...(migration?.new_sqlite_classes ?? [])]));
    const nonSqliteClasses = new Set(migrations.flatMap((migration) => [...(migration?.new_classes ?? [])]));

    for (const [index, entry] of entries.entries()) {
        validateContainerEntry(entry, `containers[${String(index)}]`, { boundClasses, errors, nonSqliteClasses, sqliteClasses, warnings });
    }

    if (wrangler.observability?.enabled !== true) {
        warnings.push(
            'containers are configured but observability is not enabled — container logs will not be captured (add { "observability": { "enabled": true } })',
        );
    }
};

/**
 * Each `workflows[]` entry must be a well-formed `{ name, binding, class_name }`
 * triple. Workflows are not Durable Objects, so there is nothing to cross-check
 * against `durable_objects`/`migrations` — only the shape matters here; the
 * deployed worker is responsible for exporting each `class_name`.
 */
const validateWorkflows = (wrangler: WranglerConfig, errors: string[]): void => {
    if (wrangler.workflows === undefined) {
        return;
    }

    if (!Array.isArray(wrangler.workflows)) {
        errors.push("workflows must be an array of { name, binding, class_name } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it so
    // member access below stays type-safe (mirrors `validateContainers`).
    const entries = wrangler.workflows as ReadonlyArray<WranglerWorkflowEntry | null | undefined>;

    for (const [index, entry] of entries.entries()) {
        const label = `workflows[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { name, binding, class_name } object`);

            continue;
        }

        if (typeof entry.binding !== "string" || entry.binding.length === 0) {
            errors.push(`${label} must have a non-empty "binding" naming the Workflow binding (e.g. WORKFLOW_ORDER_PIPELINE)`);
        }

        if (typeof entry.class_name !== "string" || entry.class_name.length === 0) {
            errors.push(`${label} must have a non-empty "class_name" naming the exported WorkflowEntrypoint class`);
        }

        if (typeof entry.name !== "string" || entry.name.length === 0) {
            errors.push(`${label} must have a non-empty "name" naming the deployed workflow`);
        }
    }
};

/** Validate the `queues.producers[]` array: each entry needs `{ binding, queue }`. */
const validateQueueProducers = (producers: ReadonlyArray<WranglerQueueProducer | null | undefined> | undefined, errors: string[]): void => {
    if (producers === undefined) {
        return;
    }

    if (!Array.isArray(producers)) {
        errors.push("queues.producers must be an array of { binding, queue } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it.
    const entries = producers as ReadonlyArray<WranglerQueueProducer | null | undefined>;

    for (const [index, entry] of entries.entries()) {
        const label = `queues.producers[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { binding, queue } object`);

            continue;
        }

        if (typeof entry.binding !== "string" || entry.binding.length === 0) {
            errors.push(`${label} must have a non-empty "binding" naming the Queue producer (e.g. QUEUE_EMAIL)`);
        }

        if (typeof entry.queue !== "string" || entry.queue.length === 0) {
            errors.push(`${label} must have a non-empty "queue" naming the deployed queue`);
        }
    }
};

/** Validate the `queues.consumers[]` array: each entry needs a `queue`. */
const validateQueueConsumers = (consumers: ReadonlyArray<WranglerQueueConsumer | null | undefined> | undefined, errors: string[]): void => {
    if (consumers === undefined) {
        return;
    }

    if (!Array.isArray(consumers)) {
        errors.push("queues.consumers must be an array of { queue } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it.
    const entries = consumers as ReadonlyArray<WranglerQueueConsumer | null | undefined>;

    for (const [index, entry] of entries.entries()) {
        const label = `queues.consumers[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { queue } object`);

            continue;
        }

        if (typeof entry.queue !== "string" || entry.queue.length === 0) {
            errors.push(`${label} must have a non-empty "queue" naming the consumed queue`);
        }
    }
};

/**
 * Validate the `queues` block: each producer needs a `{ binding, queue }` pair
 * (Lunora reconciles both from `lunora/queues.ts`), and each consumer needs a
 * `queue` (push or `type: "http_pull"`). Like workflows, queues are not Durable
 * Objects — only the shape matters; the queue resources are reconciled/created
 * separately.
 */
const validateQueues = (wrangler: WranglerConfig, errors: string[]): void => {
    if (wrangler.queues === undefined) {
        return;
    }

    if (typeof wrangler.queues !== "object" || Array.isArray(wrangler.queues)) {
        errors.push("queues must be a { producers, consumers } object");

        return;
    }

    validateQueueProducers(wrangler.queues.producers, errors);
    validateQueueConsumers(wrangler.queues.consumers, errors);
};

/**
 * Validate `secrets_store_secrets[]`: each entry references a remote store +
 * secret by name (both created out-of-band), so only the `{ binding, store_id,
 * secret_name }` shape is checked — Lunora can't mint the store/secret.
 */
const validateSecretsStore = (wrangler: WranglerConfig, errors: string[]): void => {
    if (wrangler.secrets_store_secrets === undefined) {
        return;
    }

    if (!Array.isArray(wrangler.secrets_store_secrets)) {
        errors.push("secrets_store_secrets must be an array of { binding, store_id, secret_name } entries");

        return;
    }

    const entries = wrangler.secrets_store_secrets as ReadonlyArray<{ binding?: string; secret_name?: string; store_id?: string } | null | undefined>;

    for (const [index, entry] of entries.entries()) {
        const label = `secrets_store_secrets[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { binding, store_id, secret_name } object`);

            continue;
        }

        for (const field of ["binding", "store_id", "secret_name"] as const) {
            if (typeof entry[field] !== "string" || entry[field].length === 0) {
                errors.push(`${label} must have a non-empty "${field}"`);
            }
        }
    }
};

/** A non-empty string — the shape every binding's required fields must satisfy. */
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * `Array.isArray` widens the readonly element type to `any`; restore it as a
 * record of untrusted parsed entries (each may be `null`/malformed) so the
 * generic checkers below can index arbitrary string fields type-safely.
 */
const asBindingEntries = (value: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown> | null | undefined> =>
    value as ReadonlyArray<Record<string, unknown> | null | undefined>;

/**
 * Hint-style binding arrays: each entry needs a non-empty `binding` (error); its
 * secondary field is a remote resource Lunora can't mint (a KV namespace id, a
 * Hyperdrive id, a Pipelines pipeline name, an AE dataset), so a missing one is
 * a warning — the binding can't resolve/connect without it, but only the user
 * can supply it. One descriptor table replaces four near-identical validators.
 */
const HINT_BINDING_RULES = [
    {
        arrayMessage: "kv_namespaces must be an array of { binding, id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the KV namespace binding`,
        hintField: "id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "id" — run \`wrangler kv namespace create\` and set the namespace id, or the binding can't resolve`,
        key: "kv_namespaces",
    },
    {
        arrayMessage: "flagship must be an array of { binding, app_id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Flagship binding`,
        hintField: "app_id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "app_id" — create a Flagship app and set its id, or the binding can't resolve`,
        key: "flagship",
    },
    {
        arrayMessage: "hyperdrive must be an array of { binding, id } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Hyperdrive binding`,
        hintField: "id",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "id" — run \`wrangler hyperdrive create\` and set the id, or the binding can't connect`,
        key: "hyperdrive",
    },
    {
        arrayMessage: "pipelines must be an array of { binding, stream } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Pipelines binding`,
        // wrangler renamed `pipeline` → `stream` and now deprecation-warns on the
        // old spelling; accept both so neither wrangler nor this validator is the
        // one complaining about a correctly-wired binding.
        hintField: ["stream", "pipeline"],
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "stream" — run \`wrangler pipelines create <name>\` and set the stream name, or the binding can't resolve`,
        key: "pipelines",
    },
    {
        arrayMessage: "analytics_engine_datasets must be an array of { binding, dataset } entries",
        bindingMessage: (label: string) => `${label} must have a non-empty "binding" naming the Analytics Engine binding`,
        hintField: "dataset",
        hintMessage: (label: string, binding: string) =>
            `${label} ("${binding}") has no "dataset" — it defaults to the binding name; set it explicitly to avoid drift`,
        key: "analytics_engine_datasets",
    },
] as const satisfies ReadonlyArray<{
    arrayMessage: string;
    bindingMessage: (label: string) => string;
    /** Field carrying the un-mintable remote id, or every accepted spelling of it. */
    hintField: ReadonlyArray<string> | string;
    hintMessage: (label: string, binding: string) => string;
    key: keyof WranglerConfig;
}>;

/**
 * Validate one hint-style binding array (see {@link HINT_BINDING_RULES}): a
 * non-object entry or one missing a non-empty `binding` errors; an entry whose
 * hint field is absent warns.
 */
const validateHintBinding = (wrangler: WranglerConfig, rule: (typeof HINT_BINDING_RULES)[number], errors: string[], warnings: string[]): void => {
    const value = wrangler[rule.key];

    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        errors.push(rule.arrayMessage);

        return;
    }

    for (const [index, entry] of asBindingEntries(value).entries()) {
        const label = `${rule.key}[${String(index)}]`;

        if (!entry || typeof entry !== "object" || !isNonEmptyString(entry.binding)) {
            errors.push(rule.bindingMessage(label));

            continue;
        }

        // `hintField` may name several accepted spellings — a field wrangler has
        // renamed still satisfies the rule under its old name (see `pipelines`).
        // Narrowed with `typeof`, not `Array.isArray`: the latter widens a
        // `ReadonlyArray<string> | string` union to `any[]`.
        const hintFields = typeof rule.hintField === "string" ? [rule.hintField] : rule.hintField;

        if (!hintFields.some((field) => isNonEmptyString(entry[field]))) {
            warnings.push(rule.hintMessage(label, entry.binding));
        }
    }
};

/**
 * The self-describing single-object bindings — the binding name is the whole
 * config (no array, no remote id to mint). A present block must be an object
 * with a non-empty `binding`. One table replaces the Browser/Images validators.
 */
const SELF_DESCRIBING_BINDING_RULES = [
    { key: "browser", message: 'browser must be an object with a non-empty "binding" (e.g. { "binding": "BROWSER" })' },
    { key: "images", message: 'images must be an object with a non-empty "binding" (e.g. { "binding": "IMAGES" })' },
] as const satisfies ReadonlyArray<{ key: keyof WranglerConfig; message: string }>;

/** Validate one self-describing `{ binding }` object against its rule (pure shape check). */
const validateSelfDescribingBinding = (wrangler: WranglerConfig, rule: (typeof SELF_DESCRIBING_BINDING_RULES)[number], errors: string[]): void => {
    const value = wrangler[rule.key];

    if (value === undefined) {
        return;
    }

    if (typeof value !== "object" || Array.isArray(value) || !isNonEmptyString((value as { binding?: unknown }).binding)) {
        errors.push(rule.message);
    }
};

/**
 * Binding arrays whose entries carry two or more **required** string fields (a
 * missing field is an error, not a hint). Unlike the hint bindings these
 * reference targets Lunora can't discover (a service worker, a dispatch
 * namespace, an mTLS cert id), so the shape is all we police. One table replaces
 * the Services/DispatchNamespaces/MtlsCertificates validators.
 */
const REQUIRED_FIELD_BINDING_RULES = [
    {
        arrayMessage: "services must be an array of { binding, service, entrypoint? } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the service binding` },
            { field: "service", message: (label: string) => `${label} must have a non-empty "service" naming the target Worker` },
        ],
        key: "services",
        objectMessage: (label: string) => `${label} must be a { binding, service, entrypoint? } object`,
    },
    {
        arrayMessage: "dispatch_namespaces must be an array of { binding, namespace } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding"` },
            { field: "namespace", message: (label: string) => `${label} must have a non-empty "namespace" naming the dispatch namespace` },
        ],
        key: "dispatch_namespaces",
        objectMessage: (label: string) => `${label} must be a { binding, namespace } object`,
    },
    {
        arrayMessage: "mtls_certificates must be an array of { binding, certificate_id } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding"` },
            {
                field: "certificate_id",
                message: (label: string) => `${label} must have a non-empty "certificate_id" (upload via \`wrangler mtls-certificate upload\`)`,
            },
        ],
        key: "mtls_certificates",
        objectMessage: (label: string) => `${label} must be a { binding, certificate_id } object`,
    },
] as const satisfies ReadonlyArray<{
    arrayMessage: string;
    fields: ReadonlyArray<{ field: string; message: (label: string) => string }>;
    key: keyof WranglerConfig;
    objectMessage: (label: string) => string;
}>;

/**
 * Validate one required-fields binding array (see {@link REQUIRED_FIELD_BINDING_RULES}):
 * a non-object entry errors with the rule's object message; otherwise every
 * declared field must be a non-empty string.
 */
const validateRequiredFieldsBinding = (wrangler: WranglerConfig, rule: (typeof REQUIRED_FIELD_BINDING_RULES)[number], errors: string[]): void => {
    const value = wrangler[rule.key];

    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        errors.push(rule.arrayMessage);

        return;
    }

    for (const [index, entry] of asBindingEntries(value).entries()) {
        const label = `${rule.key}[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(rule.objectMessage(label));

            continue;
        }

        for (const field of rule.fields) {
            if (!isNonEmptyString(entry[field.field])) {
                errors.push(field.message(label));
            }
        }
    }
};

/**
 * `send_email[]` (Email Routing outbound, used for auto-reply/forward from an
 * inbound `email()` worker — plan 029). The routing rule that delivers inbound
 * mail to the worker is dashboard-configured and not codegen-managed, so this is
 * a **strictly additive advisory** — like `tail_consumers` it must never turn an
 * otherwise-valid config invalid. A wrong *type* (`send_email` not an array) is a
 * malformed shape and stays an error; a per-entry missing `name` is surfaced as a
 * warning (wrangler will report the authoritative error at deploy time).
 */
const validateSendEmail = (wrangler: WranglerConfig, errors: string[], warnings: string[]): void => {
    const sendEmail = wrangler.send_email;

    if (sendEmail === undefined) {
        return;
    }

    if (!Array.isArray(sendEmail)) {
        errors.push("send_email must be an array of { name, destination_address? } entries");

        return;
    }

    const entries = sendEmail as ReadonlyArray<{ name?: string } | null | undefined>;

    for (const [index, entry] of entries.entries()) {
        if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.length === 0) {
            warnings.push(`send_email[${String(index)}] has no non-empty "name" naming the send-email binding — set one before deploying`);
        }
    }
};

/**
 * `logpush` is a known boolean key — `"logpush": true` enables Cloudflare
 * Logpush (the actual R2/HTTP/SIEM sink is a Logpush *job* created out-of-band
 * via the dashboard/API, NOT a worker binding). Recognizing the key here catches
 * a typo like `"logPush"` that wrangler would otherwise silently drop.
 */
const validateLogpush = (wrangler: WranglerConfig, errors: string[]): void => {
    if (wrangler.logpush !== undefined && typeof wrangler.logpush !== "boolean") {
        errors.push('logpush must be a boolean (set "logpush": true to enable Cloudflare Logpush)');
    }
};

/**
 * `placement` is Smart Placement config — `{ "mode": "smart" }` is the only
 * documented shape. Recognizing it catches a typo'd mode (`"smrat"`) wrangler
 * would silently drop. Smart Placement is opt-in only and never auto-injected
 * (it can regress geo-distributed latency for a DO/D1-centric app).
 */
const validatePlacement = (wrangler: WranglerConfig, errors: string[]): void => {
    const { placement } = wrangler;

    if (placement === undefined) {
        return;
    }

    if (typeof placement !== "object" || Array.isArray(placement)) {
        errors.push('placement must be an object (e.g. { "mode": "smart" })');

        return;
    }

    if (placement.mode !== undefined && placement.mode !== "smart") {
        errors.push('placement.mode must be "smart" (the only supported Smart Placement mode)');
    }
};

/**
 * `observability` enables Workers Logs + Traces. Shape-check the block and the
 * `head_sampling_rate` (a 0–1 fraction, both at the top level and under the
 * nested `logs` block) so a typo'd key or an out-of-range rate is caught before
 * deploy instead of being silently ignored by wrangler.
 */
const validateObservability = (wrangler: WranglerConfig, errors: string[]): void => {
    const { observability } = wrangler;

    if (observability === undefined) {
        return;
    }

    if (typeof observability !== "object" || Array.isArray(observability)) {
        errors.push('observability must be an object (e.g. { "enabled": true, "head_sampling_rate": 1 })');

        return;
    }

    const checkSamplingRate = (rate: unknown, path: string): void => {
        if (rate !== undefined && (typeof rate !== "number" || Number.isNaN(rate) || rate < 0 || rate > 1)) {
            errors.push(`${path} must be a number in [0, 1] (the fraction of requests sampled)`);
        }
    };

    checkSamplingRate(observability.head_sampling_rate, "observability.head_sampling_rate");

    if (observability.logs !== undefined) {
        if (typeof observability.logs !== "object" || Array.isArray(observability.logs)) {
            errors.push("observability.logs must be an object");
        } else {
            checkSamplingRate(observability.logs.head_sampling_rate, "observability.logs.head_sampling_rate");
        }
    }
};

/**
 * `cache` is the Workers Cache toggle (`{ "enabled": true }`). A present block
 * must have `enabled` be a boolean if it is set. Unknown shapes are rejected so
 * a typo like `"cache": { "enable": true }` is caught before deploy.
 */
const validateCache = (wrangler: WranglerConfig, errors: string[]): void => {
    const { cache } = wrangler;

    if (cache === undefined) {
        return;
    }

    if (typeof cache !== "object" || cache === null || Array.isArray(cache)) {
        errors.push('cache must be an object (e.g. { "enabled": true })');

        return;
    }

    if (cache.enabled !== undefined && typeof cache.enabled !== "boolean") {
        errors.push("cache.enabled must be a boolean (true or false)");
    }
};

/**
 * `exports` is the per-entrypoint cache-control map for named `WorkerEntrypoint`s.
 * Lunora apps typically use a single `export default` entrypoint, so this is
 * passthrough/shape-check only. Each value must be an object with an optional
 * `type` (string) and optional `cache.enabled` (boolean).
 */
const validateExports = (wrangler: WranglerConfig, errors: string[]): void => {
    const { exports } = wrangler;

    if (exports === undefined) {
        return;
    }

    if (typeof exports !== "object" || exports === null || Array.isArray(exports)) {
        errors.push("exports must be an object keyed by entrypoint name");

        return;
    }

    for (const [name, entry] of Object.entries(exports)) {
        if (typeof entry !== "object" || entry === null) {
            errors.push(`exports["${name}"] must be an object`);

            continue;
        }

        if (entry.type !== undefined && typeof entry.type !== "string") {
            errors.push(`exports["${name}"].type must be a string`);
        }

        if (entry.cache !== undefined) {
            if (typeof entry.cache !== "object" || entry.cache === null || Array.isArray(entry.cache)) {
                errors.push(`exports["${name}"].cache must be an object`);
            } else if (entry.cache.enabled !== undefined && typeof entry.cache.enabled !== "boolean") {
                errors.push(`exports["${name}"].cache.enabled must be a boolean`);
            }
        }
    }
};

/**
 * `assets` is the Workers Static Assets block — serves the client build from the
 * same worker (Cloudflare serves files for free, only invoking the worker on a
 * miss, so the Lunora SSR/API handler is unaffected). NOT Cloudflare Pages,
 * which is an explicit non-goal — the worker is the deploy unit. A present block
 * must declare a non-empty string `directory`; `binding`/`html_handling`/
 * `not_found_handling` if present must be strings. The directory-existence
 * nicety is FS-aware (it lives in `validateWranglerProject`, not here) because
 * the dir is created by the client build and may legitimately not exist yet.
 */
const validateAssets = (wrangler: WranglerConfig, errors: string[]): void => {
    const { assets } = wrangler;

    if (assets === undefined) {
        return;
    }

    if (typeof assets !== "object" || Array.isArray(assets)) {
        errors.push('assets must be an object (e.g. { "directory": "./dist/client", "binding": "ASSETS" })');

        return;
    }

    if (typeof assets.directory !== "string" || assets.directory.length === 0) {
        errors.push('assets must declare a non-empty "directory" pointing at the built client output (e.g. "./dist/client")');
    }

    if (assets.binding !== undefined && (typeof assets.binding !== "string" || assets.binding.length === 0)) {
        errors.push('assets.binding must be a non-empty string (e.g. "ASSETS")');
    }

    if (assets.html_handling !== undefined && typeof assets.html_handling !== "string") {
        errors.push("assets.html_handling must be a string");
    }

    if (assets.not_found_handling !== undefined && typeof assets.not_found_handling !== "string") {
        errors.push("assets.not_found_handling must be a string");
    }
};

/**
 * `tail_consumers` is optional, but a present entry must name the consumer
 * Worker via a non-empty `service`. A malformed entry would be silently
 * dropped by wrangler and the sink would never receive logs, so we surface it
 * as an error. Extracted to keep `validateWranglerConfig`'s complexity bounded.
 */
const validateTailConsumers = (wrangler: WranglerConfig, errors: string[]): void => {
    const consumers = wrangler.tail_consumers;

    if (consumers === undefined) {
        return;
    }

    if (!Array.isArray(consumers)) {
        errors.push("tail_consumers must be an array of { service, environment? } entries");

        return;
    }

    // `Array.isArray` widens the readonly element type to `any`; restore it so
    // member access below stays type-safe.
    const entries = consumers as ReadonlyArray<TailConsumer | null | undefined>;

    for (const [index, consumer] of entries.entries()) {
        if (!consumer || typeof consumer !== "object" || typeof consumer.service !== "string" || consumer.service.length === 0) {
            errors.push(`tail_consumers[${String(index)}] must have a non-empty "service" naming the consumer Worker`);
        }
    }
};

/**
 * Return a new `WranglerConfig` with `consumer` present in `tail_consumers`,
 * wiring this Worker to forward its tail events (logs/exceptions) to another
 * Worker that fans them out to an external sink. Pure and idempotent: an
 * existing entry with the same `service` + `environment` is left untouched
 * rather than duplicated, so it is safe to call on every codegen/deploy.
 */
const withTailConsumer = (wrangler: WranglerConfig, consumer: TailConsumer): WranglerConfig => {
    const existing = wrangler.tail_consumers ?? [];
    const alreadyWired = existing.some((entry) => Boolean(entry) && entry?.service === consumer.service && entry?.environment === consumer.environment);

    if (alreadyWired) {
        return wrangler;
    }

    return { ...wrangler, tail_consumers: [...existing, consumer] };
};

/** Env values that read as "on" for a boolean-ish `LUNORA_*` flag — mirrors the DO security audit. */
const TRUTHY_ENV_VALUES = new Set(["1", "enabled", "on", "true", "yes"]);

/**
 * Reject the one CORS combination the worker cannot enforce: a `*` wildcard
 * origin paired with credentials. The runtime's `resolveSecurity` throws on the
 * same combination at construction, but an env-driven allowlist
 * (`LUNORA_ALLOWED_ORIGINS` + `LUNORA_CORS_ALLOW_CREDENTIALS` in wrangler `vars`)
 * bypasses code config and would otherwise ship a policy browsers silently
 * refuse — so we catch it at build time too. Non-string values are ignored.
 */
const validateCorsVariables = (wrangler: WranglerConfig, errors: string[]): void => {
    const { vars } = wrangler;

    if (!vars || typeof vars !== "object") {
        return;
    }

    const allowedOrigins = vars["LUNORA_ALLOWED_ORIGINS"];
    const allowCredentials = vars["LUNORA_CORS_ALLOW_CREDENTIALS"];

    const hasWildcard = typeof allowedOrigins === "string" && allowedOrigins.split(",").some((entry) => entry.trim() === "*");
    const credentialsOn = typeof allowCredentials === "string" && TRUTHY_ENV_VALUES.has(allowCredentials.trim().toLowerCase());

    if (hasWildcard && credentialsOn) {
        errors.push(
            'vars.LUNORA_ALLOWED_ORIGINS includes a "*" wildcard while vars.LUNORA_CORS_ALLOW_CREDENTIALS is on — browsers reject this combination and it defeats the allowlist; name explicit origins or drop credentials',
        );
    }
};

/**
 * Pure validator: given a parsed `WranglerConfig` object and an optional
 * `SchemaInfo`, produce a structured report. Performs no I/O.
 */
const validateWranglerConfig = (wrangler: WranglerConfig | undefined, schema?: SchemaInfo): WranglerValidationReport => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!wrangler || typeof wrangler !== "object") {
        errors.push("wrangler config is not a valid object");

        return { errors, valid: false, warnings };
    }

    const durableObjectBindings = objectBindingEntries(wrangler.durable_objects?.bindings);
    const shardBinding = durableObjectBindings.find((binding) => binding.name === "SHARD" && binding.class_name === "ShardDO");

    if (!shardBinding) {
        errors.push(
            'durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" } — run `lunora dev` to auto-reconcile wrangler.jsonc, or add the binding manually',
        );
    }

    const compatibilityDate = wrangler.compatibility_date ?? "";

    // Lexical `<` only matches numeric comparison for strict `YYYY-MM-DD`; a
    // malformed string like "2026-4-7" sorts before "2026-04-07" and would
    // pass `>= REQUIRED_COMPATIBILITY_DATE` checks by accident. Enforce the
    // shape so the comparison below is meaningful.
    if (compatibilityDate && !ISO_DATE_PATTERN.test(compatibilityDate)) {
        errors.push(`compatibility_date must be in YYYY-MM-DD format (got "${compatibilityDate}")`);
    } else if (compatibilityDate < REQUIRED_COMPATIBILITY_DATE) {
        errors.push(`compatibility_date must be >= "${REQUIRED_COMPATIBILITY_DATE}" (got "${compatibilityDate || "<missing>"}")`);
    }

    // Workers Cache requires compatibility_date >= WORKERS_CACHE_MIN_DATE. Only
    // enforce this when the cache block is actually enabled, so non-cache apps
    // aren't forced to bump. Malformed dates already produced a format error
    // above, so skip the date comparison unless the shape is valid.
    if (isCacheEnabled(wrangler) && ISO_DATE_PATTERN.test(compatibilityDate) && compatibilityDate < WORKERS_CACHE_MIN_DATE) {
        errors.push(`cache.enabled requires compatibility_date >= "${WORKERS_CACHE_MIN_DATE}" (got "${compatibilityDate || "<missing>"}")`);
    }

    // `web_socket_auto_reply_to_close` became the default on 2026-04-07, the
    // same date REQUIRED_COMPATIBILITY_DATE enforces — so requiring it
    // explicitly is redundant and workerd now warns when it's set. Any
    // compatibility_date that would have made the flag mandatory already trips
    // the `>= REQUIRED_COMPATIBILITY_DATE` error above, so a separate flag error
    // adds no signal. We therefore neither require nor reject the flag here.

    if (schema?.hasGlobalTable) {
        const d1Bindings = objectBindingEntries(wrangler.d1_databases);
        const databaseBinding = d1Bindings.find((binding) => binding.binding === "DB");

        if (!databaseBinding) {
            errors.push(
                'schema declares .global() tables; d1_databases must include a binding named "DB" — run `lunora dev` to auto-reconcile wrangler.jsonc, or add the binding manually',
            );
        }
    }

    validateVectorizeBindings(wrangler, schema?.vectorIndexNames ?? [], errors);
    validateTailConsumers(wrangler, errors);
    validateContainers(wrangler, errors, warnings);
    validateWorkflows(wrangler, errors);
    validateQueues(wrangler, errors);
    validateSecretsStore(wrangler, errors);

    // Cloudflare-coverage bindings (plans 027-043), driven by descriptor tables.
    // Hint bindings warn on a missing remote id; self-describing + passthrough
    // bindings are pure shape checks. Config-only flags (logpush/placement/
    // assets) catch typos.
    for (const rule of HINT_BINDING_RULES) {
        validateHintBinding(wrangler, rule, errors, warnings);
    }

    for (const rule of REQUIRED_FIELD_BINDING_RULES) {
        validateRequiredFieldsBinding(wrangler, rule, errors);
    }

    for (const rule of SELF_DESCRIBING_BINDING_RULES) {
        validateSelfDescribingBinding(wrangler, rule, errors);
    }

    validateSendEmail(wrangler, errors, warnings);
    validateLogpush(wrangler, errors);
    validatePlacement(wrangler, errors);
    validateObservability(wrangler, errors);
    validateAssets(wrangler, errors);
    validateCache(wrangler, errors);
    validateExports(wrangler, errors);
    validateCorsVariables(wrangler, errors);

    return { errors, valid: errors.length === 0, warnings };
};

/**
 * Convenience alias matching the original task-spec signature
 * `validateWrangler(wranglerJson, schema)` returning
 * `{ valid, errors, warnings }`.
 */
const validateWrangler: typeof validateWranglerConfig = validateWranglerConfig;

interface WranglerProjectValidationOptions {
    projectRoot: string;
    schemaDir?: string;
}

interface WranglerProjectValidationResult {
    problems: ReadonlyArray<string>;
    report: WranglerValidationReport;
    wranglerPath: string | undefined;
}

/**
 * FS-aware existence check for local-path container images: every `./`, `../`,
 * `/`, or `Dockerfile`-bearing image must resolve to an existing file (wrangler
 * resolves it relative to the config file). Registry references are skipped.
 */
const collectContainerImageErrors = (
    containers: ReadonlyArray<WranglerContainerEntry | null | undefined>,
    configDirectory: string,
    wranglerPath: string,
): string[] => {
    const errors: string[] = [];

    for (const entry of containers) {
        const image = entry?.image;

        if (typeof image !== "string" || !(image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile"))) {
            continue;
        }

        if (!existsSync(image.startsWith("/") ? image : join(configDirectory, image))) {
            errors.push(
                `containers image "${image}" does not exist (resolved relative to ${wranglerPath}); create the Dockerfile or point image at a registry reference`,
            );
        }
    }

    return errors;
};

/** Where a worker entry lives when `wrangler.main` is absent. Mirrors `inferLunoraBindings`' list. */
const WORKER_ENTRY_FALLBACKS = ["src/server/index.ts", "src/server/index.tsx", "src/index.ts", "src/worker.ts"] as const;

/** Resolve the worker entry: `wrangler.main` (relative to the config file) if it exists, else the conventional fallbacks. */
const resolveWorkerEntryPath = (main: string | undefined, projectRoot: string, wranglerPath: string): string | undefined => {
    if (typeof main === "string" && main.length > 0) {
        const resolved = join(dirname(wranglerPath), main);

        return existsSync(resolved) ? resolved : undefined;
    }

    return WORKER_ENTRY_FALLBACKS.map((fallback) => join(projectRoot, fallback)).find((candidate) => existsSync(candidate));
};

/** Escape a runtime string for literal interpolation into a `RegExp` source. */
const escapeForRegExp = (value: string): string => value.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);

/**
 * Blank out comments and string/template literals, preserving offsets.
 *
 * Without this a scan for `export … SchedulerDO` matches a commented-out export
 * or a mention in prose — and a worker entry that discusses its Durable Objects
 * in comments is the normal case, so the check would silently pass on exactly
 * the tree it exists to catch. Replacing with spaces rather than deleting keeps
 * line structure intact for the `[^\n;]*` proximity bound below.
 */
// Deliberately coarse on escapes (`"a\"b"` blanks only up to the inner quote):
// the goal is that quoted text cannot pass for code, and blanking slightly less
// of a string never turns a real export into a missing one.
const COMMENT_OR_STRING_RE = /\/\/[^\n]*|\/\*.*?\*\/|"[^"\n]*"|'[^'\n]*'|`[^`]*`/gsu;

const blankCommentsAndStrings = (code: string): string =>
    // The alternation is scanned positionally, so a `//` inside a string literal
    // is consumed as part of that string rather than starting a comment.
    code.replaceAll(COMMENT_OR_STRING_RE, (match) => match.replaceAll(/[^\n]/gu, " "));

/**
 * A star re-export (`export * from "./lunora/_generated/workflows"`) forwards
 * names that no per-name scan can see. When the entry has one, absence of a
 * class name proves nothing, so the check is skipped entirely — a false error on
 * a correctly-wired project is worse than a missed one, because it blocks a
 * deploy that would have worked.
 */
const STAR_REEXPORT_RE = /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\b/u;

/**
 * Whether the worker entry exports `className` as a runtime VALUE.
 *
 * Type-only exports are the interesting negative: `export type { ShardDO }`
 * lists the name but compiles away, so the binding looks satisfied and is not.
 *
 * This is a regex scan rather than `es-module-lexer` because the validator is
 * synchronous and the lexer needs an awaited `init`. It mirrors the fallback
 * `inferLunoraBindings` already uses for an unparseable entry, and it only ever
 * runs when the entry has no star re-export.
 */
const entryExportsClassValue = (code: string, className: string): boolean => {
    const name = escapeForRegExp(className);

    const typeOnly =
        new RegExp(String.raw`\bexport\s+type\s+${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s+type\s*\{[^}]*\b${name}\b`, "u").test(code) ||
        new RegExp(String.raw`\bexport\s*\{[^}]*\btype\s+${name}\b`, "u").test(code);

    if (typeOnly) {
        return false;
    }

    return new RegExp(String.raw`\bexport\b[^\n;]*\b${name}\b`, "u").test(code);
};

/**
 * Report every `durable_objects.bindings[].class_name` and
 * `workflows[].class_name` the worker entry does not export.
 *
 * `.scheduler(...)` and `.workflow(...)` on the generated app builder write the
 * binding and the migration entry but cannot add the `export { SchedulerDO }`
 * the entry needs, so the wiring is only half done — and wrangler refuses to
 * bundle the result: "Your Worker depends on the following Durable Objects,
 * which are not exported in your entrypoint file".
 *
 * The reason this belongs in the validator rather than being left to `wrangler
 * deploy` is what `verify` and `doctor` were reporting in the meantime. Both
 * printed a clean bill of health on a tree that could not deploy, and `verify`'s
 * own description is "validate wrangler.jsonc + codegen dry-run + tsc" — the
 * thing that is invalid IS the relationship between `wrangler.jsonc` and the
 * entry. Only `lunora build`, which shells out to `wrangler deploy --dry-run`,
 * caught it. Two capabilities shipped with this shape, which suggests the
 * pattern rather than the instances is the defect.
 *
 * Both files are already parsed here, so this is a string-set comparison.
 */
const collectUnexportedClassErrors = (wrangler: WranglerConfig, projectRoot: string, wranglerPath: string): string[] => {
    const entryPath = resolveWorkerEntryPath(wrangler.main, projectRoot, wranglerPath);

    if (entryPath === undefined) {
        return [];
    }

    let source: string;

    try {
        source = readFileSync(entryPath, "utf8");
    } catch {
        return [];
    }

    // Comments and strings are blanked first, so a commented-out export or a
    // class name mentioned in prose cannot pass for a real one.
    const code = blankCommentsAndStrings(source);

    if (STAR_REEXPORT_RE.test(code)) {
        return [];
    }

    const declared: { className: string; label: string }[] = [];

    for (const binding of objectBindingEntries(wrangler.durable_objects?.bindings)) {
        // A binding naming a class in ANOTHER script is that script's to export;
        // only same-script bindings constrain this entry.
        if (typeof binding.class_name === "string" && binding.class_name.length > 0 && binding.script_name === undefined) {
            declared.push({ className: binding.class_name, label: "durable_objects.bindings" });
        }
    }

    for (const entry of wrangler.workflows ?? []) {
        if (typeof entry?.class_name === "string" && entry.class_name.length > 0) {
            declared.push({ className: entry.class_name, label: "workflows" });
        }
    }

    const missing = declared.filter((entry) => !entryExportsClassValue(code, entry.className));

    return missing.map(
        (entry) =>
            `${entry.label} declares class "${entry.className}" but the worker entry (${entryPath}) does not export it — ` +
            `wrangler refuses to bundle a Worker whose Durable Object classes are not exported. ` +
            `Add \`export { ${entry.className} } from "…";\` to the entry.`,
    );
};

/**
 * File-system aware variant: reads `wrangler.jsonc`/`wrangler.json` from
 * the given project root, discovers the schema (if any), and delegates to
 * `validateWranglerConfig`. Returns the legacy
 * `{ problems, wranglerPath }` shape plus the structured `report`.
 */
const validateWranglerProject = (options: WranglerProjectValidationOptions): WranglerProjectValidationResult => {
    const schemaDirectory = options.schemaDir ?? "lunora";
    const wranglerPath = findWranglerFile(options.projectRoot);

    if (!wranglerPath) {
        const message = `wrangler.jsonc not found in ${options.projectRoot}; create one declaring at least the SHARD durable object binding.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath: undefined,
        };
    }

    const { parsed: wrangler } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (wrangler === undefined) {
        const message = `failed to parse ${wranglerPath} as JSONC.`;

        return {
            problems: [message],
            report: { errors: [message], valid: false, warnings: [] },
            wranglerPath,
        };
    }

    // Surface a parse failure as a warning rather than swallowing it — codegen
    // reports the actionable error elsewhere, but a complete miss is hard to debug.
    const { error: schemaError, info: schemaInfo } = discoverSchemaInfo(options.projectRoot, schemaDirectory);
    const report = validateWranglerConfig(wrangler, schemaInfo);

    if (schemaError !== undefined) {
        report.warnings.push(`schema parse failed in ${schemaDirectory}/schema.ts: ${schemaError}`);
    }

    // FS-aware: a local-path container image must point at an existing
    // Dockerfile (wrangler resolves it relative to the config file). Registry
    // references are left to wrangler — pure shape checks already ran above.
    const configDirectory = dirname(wranglerPath);

    report.errors.push(
        ...collectContainerImageErrors(wrangler.containers ?? [], configDirectory, wranglerPath),
        // FS-aware: every declared Durable Object / Workflow class must be
        // exported by the worker entry, or wrangler refuses to bundle.
        ...collectUnexportedClassErrors(wrangler, options.projectRoot, wranglerPath),
    );

    // FS-aware: `assets.directory` is created by the client build, so it may
    // legitimately not exist at validation time (pre-build). Surface a *warning*
    // (never an error) so pre-build validation flows aren't broken — mirrors the
    // container-image existence check above, but downgraded to a warning.
    const assetsDirectory = wrangler.assets?.directory;

    if (typeof assetsDirectory === "string" && assetsDirectory.length > 0) {
        const resolved = assetsDirectory.startsWith("/") ? assetsDirectory : join(configDirectory, assetsDirectory);

        if (!existsSync(resolved)) {
            report.warnings.push(`assets.directory "${assetsDirectory}" does not exist yet — it is created by the client build; run the build before deploy`);
        }
    }

    report.valid = report.errors.length === 0;

    return {
        problems: report.errors,
        report,
        wranglerPath,
    };
};

export type {
    TailConsumer,
    WranglerConfig,
    WranglerContainerEntry,
    WranglerProjectValidationOptions,
    WranglerProjectValidationResult,
    WranglerValidationReport,
    WranglerWorkflowEntry,
};
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWrangler, validateWranglerConfig, validateWranglerProject, withTailConsumer };
