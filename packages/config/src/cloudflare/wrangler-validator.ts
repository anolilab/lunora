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

import { isEnvEnabled } from "../../../../shared/env-flag";
import { WORKER_ENTRY_FALLBACKS } from "../infer-bindings";
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
    // The `database_id` / `database_name` are remote resources Lunora can't mint
    // (`wrangler d1 create`) — `validateD1Databases` checks the shape (binding +
    // at least one of the two) only.
    d1_databases?: ReadonlyArray<{ binding?: string; database_id?: string; database_name?: string } | null | undefined>;
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
    // Structural only (`validateR2Buckets`): a declared bucket needs a
    // `bucket_name` — the remote bucket itself (`wrangler r2 bucket create`) is
    // out of scope for a pure validator.
    r2_buckets?: ReadonlyArray<{ binding?: string; bucket_name?: string } | null | undefined>;
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
 * `env.<name>` keys confirmed NON-inheritable by the current Cloudflare docs
 * (`workers/wrangler/configuration/`, "Non-inheritable keys" section, checked
 * 2026-07-31): wrangler does NOT fall back to the top-level value for these
 * when a declared environment omits one — each must be redeclared per
 * environment or it is simply absent there. Every entry below except
 * `d1_databases` is named verbatim in that section's list.
 *
 * `d1_databases` is not in the docs' literal enumeration, but every OTHER
 * binding-shaped key in that same list (`durable_objects`, `kv_namespaces`,
 * `r2_buckets`, `vectorize`, `services`, `queues`, `workflows`,
 * `tail_consumers`, `secrets_store_secrets`) is confirmed non-inheritable,
 * and the section's own framing is general — "Bindings, such as `vars` or
 * `kv_namespaces`, are not inheritable and need to be defined explicitly." A
 * D1 binding is a binding by every definition Cloudflare uses elsewhere in
 * the same document, so treating it the same as its siblings here is a
 * same-pattern inference from a direct quote, not a guess. Flagged so a
 * future reviewer can re-check it if Cloudflare's docs are ever updated to
 * state it explicitly (or to contradict this).
 */
const NON_INHERITABLE_KEYS = [
    "d1_databases",
    "durable_objects",
    "kv_namespaces",
    "queues",
    "r2_buckets",
    "secrets_store_secrets",
    "services",
    "tail_consumers",
    "vars",
    "vectorize",
    "workflows",
] as const satisfies ReadonlyArray<keyof WranglerConfig>;

/**
 * `env.<name>` keys confirmed INHERITABLE by the same docs section: an
 * environment that does not override one still gets the top-level value.
 * Limited to the keys this validator actually reads — the docs' "Inheritable
 * keys" list is longer (`name`, `route`, `triggers`, …) but this project does
 * not validate those fields, so extending the table to cover them would add
 * surface with nothing exercising it.
 */
const INHERITABLE_KEYS = [
    "assets",
    "compatibility_date",
    "exports",
    "logpush",
    "main",
    "migrations",
    "observability",
    "placement",
] as const satisfies ReadonlyArray<keyof WranglerConfig>;

interface WranglerEnvironmentMerge {
    /** Set when `environment` names no `env.<name>` block declared in the config — the caller should treat this as a hard validation failure. */
    error?: string;
    /** The env-scoped view: `wrangler` unchanged when `environment` is `undefined`, otherwise merged per {@link NON_INHERITABLE_KEYS} / {@link INHERITABLE_KEYS}. */
    merged: WranglerConfig;

    /**
     * Keys the env block overrides whose inheritance status this validator
     * cannot verify (not in either table above) — validated against the
     * TOP-LEVEL value only, per the "do not guess" rule; the override is
     * silently ignored for validation purposes. The caller logs this ONCE
     * (not per key) so an unusual `env.<name>` block doesn't spam warnings.
     */
    unverifiedKeys: string[];
}

/**
 * Resolve the config view `wrangler deploy --env <environment>` will actually
 * use. Undefined `environment` returns `wrangler` unchanged — the top-level
 * config is what a plain `wrangler deploy` reads, same as today.
 *
 * Deliberately independent of any other merge in this module: called fresh
 * from the ORIGINAL `wrangler` each time (see both call sites), so there is
 * no risk of merging an already-merged config and silently losing the
 * top-level fallback a second merge pass would no longer have access to.
 */
const mergeWranglerEnvironment = (wrangler: WranglerConfig, environment: string | undefined): WranglerEnvironmentMerge => {
    if (environment === undefined) {
        return { merged: wrangler, unverifiedKeys: [] };
    }

    const envBlock = wrangler.env?.[environment];

    if (envBlock === undefined) {
        const declared = Object.keys(wrangler.env ?? {}).toSorted((a, b) => a.localeCompare(b));
        const declaredSuffix = declared.length > 0 ? ` (declared: ${declared.join(", ")}).` : " (no environments are declared).";

        return {
            error: `--env "${environment}" names no environment declared in wrangler.jsonc's "env" block${declaredSuffix}`,
            merged: wrangler,
            unverifiedKeys: [],
        };
    }

    // Baseline: the top-level config, `env` included — harmless since nothing
    // downstream reads `merged.env`, and this function is always called fresh
    // from the ORIGINAL `wrangler` (see both call sites), never from an
    // already-merged result, so there is no risk of a stale `env` block
    // confusing a later merge. A key the env block never mentions — inheritable,
    // non-inheritable, or unverified alike — keeps its top-level value here,
    // which is correct for all three cases EXCEPT when the env block DOES
    // override an inheritable or non-inheritable key, handled below.
    const merged: WranglerConfig = { ...wrangler };
    const envBlockKeys = Object.keys(envBlock).filter((key) => key !== "env") as ReadonlyArray<keyof WranglerConfig>;

    for (const key of envBlockKeys) {
        if ((INHERITABLE_KEYS as ReadonlyArray<keyof WranglerConfig>).includes(key)) {
            // Env overrides top-level when present — exactly what "inheritable"
            // means: absent, it already fell through from the baseline above.
            (merged as Record<string, unknown>)[key] = (envBlock as Record<string, unknown>)[key];
        }
    }

    // Non-inheritable: use ONLY the env block's value, even when the block
    // doesn't set it (making it `undefined`) — a declared environment that
    // doesn't repeat a binding does NOT inherit the top level's, which is
    // exactly the gap this closes (a missing SHARD binding at the top level
    // is a false negative for `--env production` if that env has its own).
    for (const key of NON_INHERITABLE_KEYS) {
        (merged as Record<string, unknown>)[key] = (envBlock as Record<string, unknown>)[key];
    }

    const knownKeys = new Set<string>([...NON_INHERITABLE_KEYS, ...INHERITABLE_KEYS]);
    const unverifiedKeys = envBlockKeys.filter((key) => !knownKeys.has(key)).map(String);

    return { merged, unverifiedKeys };
};

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

/** A non-empty string — the shape every binding's required fields must satisfy. */
const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/**
 * The object-typed entries of a possibly-malformed bindings array from untrusted
 * JSONC. Tolerates a non-array value (e.g. a stray string) and drops `null` /
 * non-object entries (a trailing comma in JSONC parses to `[null]`), so callers
 * can safely `.find`/`.map` string fields without a raw `TypeError`.
 */
const objectBindingEntries = <T>(value: ReadonlyArray<T | null | undefined> | undefined): T[] =>
    Array.isArray(value) ? value.filter((entry): entry is T => entry !== null && typeof entry === "object") : [];

/**
 * The string members of a hand-written array field, or `[]` for anything that
 * isn't one — the string-valued twin of {@link objectBindingEntries}, and needed
 * for the same reason: a `wrangler.jsonc` is hand-edited, so `"new_classes": {}`
 * would make a bare `for…of` throw a raw `TypeError` out of the validator, and
 * `"new_classes": "ShardDO"` would fold in one CHARACTER per iteration.
 */
const stringEntries = (value: unknown): string[] => (Array.isArray(value) ? (value as unknown[]).filter((entry) => isNonEmptyString(entry)) : []);

/**
 * Fold `wrangler.migrations[]` IN ORDER into the set of Durable Object classes
 * that currently exist, applying each entry's `new_classes` +
 * `new_sqlite_classes` (add), then its `renamed_classes` (from → to), then its
 * `deleted_classes` (remove) — in that order, one entry at a time.
 *
 * This must stay a fold, not a single-entry membership scan: a class added in
 * one entry and renamed in a later one is only findable under its NEW name,
 * and a class added then later deleted must NOT be findable at all. A naive
 * "does this class appear anywhere in migrations" check gets both cases
 * wrong. See plan 353.
 */
const foldMigrationClasses = (migrations: WranglerConfig["migrations"]): ReadonlySet<string> => {
    const classes = new Set<string>();

    for (const migration of objectBindingEntries(migrations)) {
        for (const name of stringEntries(migration.new_classes)) {
            classes.add(name);
        }

        for (const name of stringEntries(migration.new_sqlite_classes)) {
            classes.add(name);
        }

        for (const rename of objectBindingEntries(migration.renamed_classes)) {
            if (isNonEmptyString(rename.from) && isNonEmptyString(rename.to)) {
                classes.delete(rename.from);
                classes.add(rename.to);
            }
        }

        for (const name of stringEntries(migration.deleted_classes)) {
            classes.delete(name);
        }
    }

    return classes;
};

/**
 * Every `durable_objects.bindings[]` entry whose class lives in THIS script
 * (no `script_name`) must be a class {@link foldMigrationClasses} says
 * currently exists — otherwise `wrangler deploy` fails with "You must add a
 * new migration for the following durable object classes: X", a hard deploy
 * failure this validator exists to catch before deploy time. A binding
 * naming a class in ANOTHER script is that script's migrations to carry, not
 * this config's (same carve-out as {@link collectUnexportedClassErrors}).
 */
const validateDurableObjectMigrations = (wrangler: WranglerConfig, errors: string[]): void => {
    const currentClasses = foldMigrationClasses(wrangler.migrations);

    for (const binding of objectBindingEntries(wrangler.durable_objects?.bindings)) {
        if (binding.script_name === undefined && isNonEmptyString(binding.class_name) && !currentClasses.has(binding.class_name)) {
            errors.push(
                `durable_objects.bindings declares class "${binding.class_name}" but it is missing from migrations — ` +
                    `add a migration entry with "new_sqlite_classes": ["${binding.class_name}"] (or "new_classes" for a non-SQLite-backed class), ` +
                    "or run `lunora dev` to auto-reconcile wrangler.jsonc",
            );
        }
    }
};

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
 * `Array.isArray` widens the readonly element type to `any`; restore it as a
 * record of untrusted parsed entries (each may be `null`/malformed) so the
 * generic checkers below can index arbitrary string fields type-safely.
 */
const asBindingEntries = (value: ReadonlyArray<unknown>): ReadonlyArray<Record<string, unknown> | null | undefined> =>
    value as ReadonlyArray<Record<string, unknown> | null | undefined>;

/** The shape checks for one binding array whose entries carry required string fields. */
interface RequiredFieldsRule {
    arrayMessage: string;
    fields: ReadonlyArray<{ field: string; message: (label: string) => string }>;
    objectMessage: (label: string) => string;
}

/**
 * Validate one required-fields binding array: a non-array value errors with the
 * rule's array message, a non-object entry with its object message; otherwise
 * every declared field must be a non-empty string. The one core behind the
 * workflows / queues / secrets-store validators and
 * {@link REQUIRED_FIELD_BINDING_RULES}.
 */
const validateRequiredFieldEntries = (value: unknown, labelPrefix: string, rule: RequiredFieldsRule, errors: string[]): void => {
    if (value === undefined) {
        return;
    }

    if (!Array.isArray(value)) {
        errors.push(rule.arrayMessage);

        return;
    }

    for (const [index, entry] of asBindingEntries(value).entries()) {
        const label = `${labelPrefix}[${String(index)}]`;

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
 * Each `workflows[]` entry must be a well-formed `{ name, binding, class_name }`
 * triple. Workflows are not Durable Objects, so there is nothing to cross-check
 * against `durable_objects`/`migrations` — only the shape matters here; the
 * deployed worker is responsible for exporting each `class_name`.
 */
const WORKFLOWS_RULE: RequiredFieldsRule = {
    arrayMessage: "workflows must be an array of { name, binding, class_name } entries",
    fields: [
        { field: "binding", message: (label) => `${label} must have a non-empty "binding" naming the Workflow binding (e.g. WORKFLOW_ORDER_PIPELINE)` },
        { field: "class_name", message: (label) => `${label} must have a non-empty "class_name" naming the exported WorkflowEntrypoint class` },
        { field: "name", message: (label) => `${label} must have a non-empty "name" naming the deployed workflow` },
    ],
    objectMessage: (label) => `${label} must be a { name, binding, class_name } object`,
};

const QUEUE_PRODUCERS_RULE: RequiredFieldsRule = {
    arrayMessage: "queues.producers must be an array of { binding, queue } entries",
    fields: [
        { field: "binding", message: (label) => `${label} must have a non-empty "binding" naming the Queue producer (e.g. QUEUE_EMAIL)` },
        { field: "queue", message: (label) => `${label} must have a non-empty "queue" naming the deployed queue` },
    ],
    objectMessage: (label) => `${label} must be a { binding, queue } object`,
};

const QUEUE_CONSUMERS_RULE: RequiredFieldsRule = {
    arrayMessage: "queues.consumers must be an array of { queue } entries",
    fields: [{ field: "queue", message: (label) => `${label} must have a non-empty "queue" naming the consumed queue` }],
    objectMessage: (label) => `${label} must be a { queue } object`,
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

    validateRequiredFieldEntries(wrangler.queues.producers, "queues.producers", QUEUE_PRODUCERS_RULE, errors);
    validateRequiredFieldEntries(wrangler.queues.consumers, "queues.consumers", QUEUE_CONSUMERS_RULE, errors);
};

/**
 * Each `secrets_store_secrets[]` entry references a remote store + secret by
 * name (both created out-of-band), so only the `{ binding, store_id,
 * secret_name }` shape is checked — Lunora can't mint the store/secret.
 */
const SECRETS_STORE_RULE: RequiredFieldsRule = {
    arrayMessage: "secrets_store_secrets must be an array of { binding, store_id, secret_name } entries",
    fields: ["binding", "store_id", "secret_name"].map((field) => {
        return { field, message: (label: string) => `${label} must have a non-empty "${field}"` };
    }),
    objectMessage: (label) => `${label} must be a { binding, store_id, secret_name } object`,
};

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
    {
        // Unlike kv_namespaces/hyperdrive/pipelines (HINT_BINDING_RULES), the
        // bucket_name is not a remote id Lunora waits on Cloudflare to mint —
        // it is chosen by the project, so a missing one is a structural error,
        // not a hint.
        arrayMessage: "r2_buckets must be an array of { binding, bucket_name } entries",
        fields: [
            { field: "binding", message: (label: string) => `${label} must have a non-empty "binding" naming the R2 bucket binding` },
            { field: "bucket_name", message: (label: string) => `${label} must have a non-empty "bucket_name" naming the deployed bucket` },
        ],
        key: "r2_buckets",
        objectMessage: (label: string) => `${label} must be a { binding, bucket_name } object`,
    },
] as const satisfies ReadonlyArray<RequiredFieldsRule & { key: keyof WranglerConfig }>;

/**
 * Structural check for every `d1_databases[]` entry: a non-empty `binding`,
 * plus a `database_id` or a `database_name` identifying which database it
 * binds. Both are remote-ish (created via `wrangler d1 create`, which prints
 * an id and takes a name), but unlike the HINT_BINDING_RULES bindings a D1
 * entry with NEITHER is unusable, so this stays an error like the other
 * structural checks — matching {@link REQUIRED_FIELD_BINDING_RULES}'s bar
 * rather than the hint-only one. "Either field" doesn't fit
 * {@link RequiredFieldsRule} (which requires every listed field), so this is
 * hand-rolled rather than a table entry.
 */
const validateD1Databases = (wrangler: WranglerConfig, errors: string[]): void => {
    const { d1_databases: d1Databases } = wrangler;

    if (d1Databases === undefined) {
        return;
    }

    if (!Array.isArray(d1Databases)) {
        errors.push("d1_databases must be an array of { binding, database_id | database_name } entries");

        return;
    }

    for (const [index, entry] of asBindingEntries(d1Databases).entries()) {
        const label = `d1_databases[${String(index)}]`;

        if (!entry || typeof entry !== "object") {
            errors.push(`${label} must be a { binding, database_id | database_name } object`);

            continue;
        }

        if (!isNonEmptyString(entry.binding)) {
            errors.push(`${label} must have a non-empty "binding" naming the D1 binding`);
        }

        if (!isNonEmptyString(entry.database_id) && !isNonEmptyString(entry.database_name)) {
            errors.push(`${label} must have a "database_id" or a "database_name" — run \`wrangler d1 create\` and set one, or the binding can't resolve`);
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
    const credentialsOn = isEnvEnabled(allowCredentials);

    if (hasWildcard && credentialsOn) {
        errors.push(
            'vars.LUNORA_ALLOWED_ORIGINS includes a "*" wildcard while vars.LUNORA_CORS_ALLOW_CREDENTIALS is on — browsers reject this combination and it defeats the allowlist; name explicit origins or drop credentials',
        );
    }
};

/**
 * Resolve the env-scoped view for {@link validateWranglerConfig} and fold in
 * its "unverified key" warning. Pulled out purely to keep
 * `validateWranglerConfig`'s cognitive complexity within the repo's lint
 * budget — no behavior change from inlining it.
 */
const resolveEnvironmentView = (
    wrangler: WranglerConfig,
    environment: string | undefined,
    warnings: string[],
): { error?: string; wrangler: WranglerConfig } => {
    const { error, merged, unverifiedKeys } = mergeWranglerEnvironment(wrangler, environment);

    if (error !== undefined) {
        return { error, wrangler: merged };
    }

    if (unverifiedKeys.length > 0) {
        warnings.push(
            `env.${String(environment)} overrides ${unverifiedKeys.join(", ")}, which this validator doesn't have a verified inheritance rule for — validated against the TOP-LEVEL value only. Double-check ${unverifiedKeys.length === 1 ? "it" : "them"} by hand for "${String(environment)}".`,
        );
    }

    return { wrangler: merged };
};

/**
 * Pure validator: given a parsed `WranglerConfig` object and an optional
 * `SchemaInfo`, produce a structured report. Performs no I/O.
 *
 * `environment`, when set, validates the `env.<environment>` view
 * ({@link mergeWranglerEnvironment}) instead of the top-level config — e.g. a
 * `durable_objects` binding present only at the top level is a validation
 * FAILURE for `--env production` if `env.production` doesn't repeat it,
 * because `durable_objects` is non-inheritable and wrangler will not carry it
 * over. Omit `environment` to validate the top level only (unchanged default).
 */
const validateWranglerConfig = (wranglerInput: WranglerConfig | undefined, schema?: SchemaInfo, environment?: string): WranglerValidationReport => {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!wranglerInput || typeof wranglerInput !== "object") {
        errors.push("wrangler config is not a valid object");

        return { errors, valid: false, warnings };
    }

    const { error: environmentError, wrangler } = resolveEnvironmentView(wranglerInput, environment, warnings);

    if (environmentError !== undefined) {
        errors.push(environmentError);

        return { errors, valid: false, warnings };
    }

    const durableObjectBindings = objectBindingEntries(wrangler.durable_objects?.bindings);
    const shardBinding = durableObjectBindings.find((binding) => binding.name === "SHARD" && binding.class_name === "ShardDO");

    if (!shardBinding) {
        errors.push(
            'durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" } — run `lunora dev` to auto-reconcile wrangler.jsonc, or add the binding manually',
        );
    }

    validateDurableObjectMigrations(wrangler, errors);

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

    validateD1Databases(wrangler, errors);
    validateVectorizeBindings(wrangler, schema?.vectorIndexNames ?? [], errors);
    validateTailConsumers(wrangler, errors);
    validateContainers(wrangler, errors, warnings);
    validateRequiredFieldEntries(wrangler.workflows, "workflows", WORKFLOWS_RULE, errors);
    validateQueues(wrangler, errors);
    validateRequiredFieldEntries(wrangler.secrets_store_secrets, "secrets_store_secrets", SECRETS_STORE_RULE, errors);

    // Cloudflare-coverage bindings (plans 027-043), driven by descriptor tables.
    // Hint bindings warn on a missing remote id; self-describing + passthrough
    // bindings are pure shape checks. Config-only flags (logpush/placement/
    // assets) catch typos.
    for (const rule of HINT_BINDING_RULES) {
        validateHintBinding(wrangler, rule, errors, warnings);
    }

    for (const rule of REQUIRED_FIELD_BINDING_RULES) {
        validateRequiredFieldEntries(wrangler[rule.key], rule.key, rule, errors);
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
    /**
     * Cloudflare environment to validate against `env.<name>` in
     * wrangler.jsonc. See {@link mergeWranglerEnvironment} for which keys
     * inherit the top-level value vs must be redeclared per environment.
     * Omit to validate the top-level config only (unchanged default).
     */
    environment?: string;
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

/** Resolve the worker entry: `wrangler.main` (relative to the config file) if it exists, else the conventional fallbacks. */
const resolveWorkerEntryPath = (main: string | undefined, projectRoot: string, wranglerPath: string): string | undefined => {
    if (typeof main === "string" && main.length > 0) {
        const resolved = join(dirname(wranglerPath), main);

        return existsSync(resolved) ? resolved : undefined;
    }

    return WORKER_ENTRY_FALLBACKS.map((fallback) => join(projectRoot, fallback)).find((candidate) => existsSync(candidate));
};

/**
 * Blank out comments and string/template literals, preserving offsets.
 *
 * Without this, a commented-out export or a class named in prose reads as a real
 * export — and a worker entry that discusses its Durable Objects in comments is
 * the normal case, so the check would silently pass on exactly the tree it
 * exists to catch. Replacing with spaces rather than deleting keeps every offset
 * and line intact.
 *
 * Deliberately coarse on escapes (`"a\"b"` blanks only up to the inner quote):
 * the goal is that quoted text cannot pass for code, and blanking slightly less
 * of a string never turns a real export into a missing one.
 */
const COMMENT_OR_STRING_RE = /\/\/[^\n]*|\/\*.*?\*\/|"[^"\n]*"|'[^'\n]*'|`[^`]*`/gsu;

const blankCommentsAndStrings = (code: string): string =>
    // The alternation is scanned positionally, so a `//` inside a string literal
    // is consumed as part of that string rather than starting a comment.
    code.replaceAll(COMMENT_OR_STRING_RE, (match) => match.replaceAll(/[^\n]/gu, " "));

/**
 * A star re-export (`export * from "./lunora/_generated/workflows"`) forwards
 * names no per-name scan can see. When the entry has one, absence of a class
 * name proves nothing, so the check is skipped entirely — a false error on a
 * correctly-wired project is worse than a missed one, because it blocks a deploy
 * that would have worked.
 */
const STAR_REEXPORT_RE = /\bexport\s*\*\s*(?:as\s+\w+\s*)?from\b/u;

/** Every `export` keyword position in the blanked source. */
const EXPORT_KEYWORD_RE = /\bexport\b/gu;

/** Modifiers that may sit between `export` and the declaration keyword. */
const EXPORT_MODIFIERS_RE = /^\s*(?:(?:abstract|async|declare|default)\s+)*/u;

/** A declaration-form export, once its modifiers are stripped (`class X`, `const X`, `function X`). */
const EXPORT_DECLARATION_RE = /^(?:class|const|function|let|var)\s+(?<name>[$A-Z_a-z][\w$]*)/u;

/**
 * A destructuring export — `export const { ShardDO, SessionDO } = app;`.
 *
 * This is the generated app builder's OWN pattern, so it is not an exotic form:
 * `apps/playground/src/server/index.ts` ships exactly this. A scanner that only
 * understood `export const <identifier>` reported the repo's own playground as
 * missing `ShardDO`.
 */
const EXPORT_DESTRUCTURE_RE = /^\s*(?:const|let|var)\s*\{/u;

/**
 * The names the worker entry exports as runtime VALUES.
 *
 * Deliberately a small scanner over export CLAUSES rather than a proximity
 * regex. The proximity form (`export…[^\n;]*Name`) gets two realistic cases
 * wrong, and both fail CLOSED — reporting a correctly-wired project as broken,
 * which blocks a deploy that would have worked:
 *
 * A brace clause wrapped across lines — how prettier formats three or more
 * exports — cannot be matched by a bound that stops at the newline. And a
 * type-only export ANYWHERE in the file suppressed the real value export of the
 * same name (`export type { ShardDO as T }` beside `export { ShardDO }`),
 * because the type check was whole-file rather than per clause.
 *
 * `es-module-lexer` would be the right tool and is a dependency, but its WASM
 * entry needs an awaited `init` (this validator is synchronous) and its pure-JS
 * entry emits a V8 asm.js warning to stderr on load, which would appear on every
 * `prepare` / `verify` / `deploy`.
 *
 * For `export { Local as Exported }` the EXPORTED name is what wrangler binds,
 * so that is what is collected.
 */
/** The leading identifier of a binding, after any `:` rename. */
const LEADING_IDENTIFIER_RE = /^[$A-Z_a-z][\w$]*/u;

/** `export type …` — the whole clause compiles away. */
const TYPE_CLAUSE_RE = /^type\b/u;

/** Split one export specifier into its words, so `X as Y` and `type X` are separable. */
const SPECIFIER_WORDS_RE = /\s+/u;

/**
 * Names bound by a named-export clause body (`A, B as C, type D`).
 *
 * For `A as B` the EXPORTED name is `B`, which is what wrangler binds. A leading
 * `type` marks that one specifier type-only — scoped per specifier, because a
 * whole-file check let an unrelated `export type { X as … }` suppress a real
 * `export { X }`.
 */
const namedClauseExports = (clauseBody: string): string[] => {
    const names: string[] = [];

    for (const specifier of clauseBody.split(",")) {
        const words = specifier.trim().split(SPECIFIER_WORDS_RE).filter(Boolean);
        const last = words.at(-1);

        if (last !== undefined && words[0] !== "type") {
            names.push(last);
        }
    }

    return names;
};

/**
 * Names bound by a destructuring export body (`A, B: C`).
 *
 * `export const { ShardDO } = app;` is the generated app builder's own pattern,
 * so this is not an exotic form — the repo's playground ships exactly it.
 */
const destructuredExports = (patternBody: string): string[] => {
    const names: string[] = [];

    for (const binding of patternBody.split(",")) {
        const bound = binding.includes(":") ? binding.slice(binding.indexOf(":") + 1) : binding;
        const identifier = LEADING_IDENTIFIER_RE.exec(bound.trim());

        if (identifier) {
            names.push(identifier[0]);
        }
    }

    return names;
};

/** The body of the first `{…}` at the start of `source`, or `undefined`. */
const braceBody = (source: string): string | undefined => {
    const open = source.indexOf("{");
    const close = source.indexOf("}", open);

    return open === -1 || close === -1 ? undefined : source.slice(open + 1, close);
};

/** Names one `export` keyword contributes as runtime values. */
const exportNamesAt = (after: string): string[] => {
    const trimmed = after.trimStart();

    if (TYPE_CLAUSE_RE.test(trimmed)) {
        return [];
    }

    if (trimmed.startsWith("{")) {
        const body = braceBody(trimmed);

        return body === undefined ? [] : namedClauseExports(body);
    }

    if (EXPORT_DESTRUCTURE_RE.test(after)) {
        const body = braceBody(after);

        return body === undefined ? [] : destructuredExports(body);
    }

    const declaration = EXPORT_DECLARATION_RE.exec(after.replace(EXPORT_MODIFIERS_RE, ""));

    return declaration?.groups?.["name"] === undefined ? [] : [declaration.groups["name"]];
};

const collectValueExportNames = (code: string): Set<string> => {
    const names = new Set<string>();

    for (const match of code.matchAll(EXPORT_KEYWORD_RE)) {
        for (const name of exportNamesAt(code.slice(match.index + "export".length))) {
            names.add(name);
        }
    }

    return names;
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
 * caught it.
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
        // Same `script_name` carve-out as the durable-object bindings above:
        // Cloudflare lets a workflow binding target a class in ANOTHER Worker,
        // which that script exports, not this entry.
        if (typeof entry?.class_name === "string" && entry.class_name.length > 0 && entry.script_name === undefined) {
            declared.push({ className: entry.class_name, label: "workflows" });
        }
    }

    const exported = collectValueExportNames(code);
    const missing = declared.filter((entry) => !exported.has(entry.className));

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

    // Resolved ONCE for the FS-aware checks below, straight from the raw
    // `wrangler` — kept independent of `validateWranglerConfig`'s own
    // equivalent merge (called with `options.environment` a few lines down)
    // rather than fed this result, so there is exactly one merge input
    // (`wrangler` unmerged) and no risk of double-merging an already-merged
    // config, which would look up `merged.env` and find nothing.
    const { error: environmentError, merged: resolvedWrangler } = mergeWranglerEnvironment(wrangler, options.environment);

    if (environmentError !== undefined) {
        return {
            problems: [environmentError],
            report: { errors: [environmentError], valid: false, warnings: [] },
            wranglerPath,
        };
    }

    // Surface a parse failure as a warning rather than swallowing it — codegen
    // reports the actionable error elsewhere, but a complete miss is hard to debug.
    const { error: schemaError, info: schemaInfo } = discoverSchemaInfo(options.projectRoot, schemaDirectory);
    const report = validateWranglerConfig(wrangler, schemaInfo, options.environment);

    if (schemaError !== undefined) {
        report.warnings.push(`schema parse failed in ${schemaDirectory}/schema.ts: ${schemaError}`);
    }

    // FS-aware: a local-path container image must point at an existing
    // Dockerfile (wrangler resolves it relative to the config file). Registry
    // references are left to wrangler — pure shape checks already ran above.
    const configDirectory = dirname(wranglerPath);

    report.errors.push(...collectContainerImageErrors(resolvedWrangler.containers ?? [], configDirectory, wranglerPath));

    // FS-aware: every declared Durable Object / Workflow class must be exported
    // by the worker entry, or wrangler refuses to bundle.
    //
    // A WARNING, not an error, and deliberately so. `collectValueExportNames` is
    // a scanner, not a parser, and every form it does not know fails CLOSED —
    // reporting a correctly-wired project as broken, which blocks `prepare` /
    // `deploy` and stops `lunora dev` from starting. Two such forms (a
    // prettier-wrapped clause, and the generated app builder's own
    // `export const { ShardDO } = app`) were found in a single review pass, which
    // is enough evidence that more exist.
    //
    // Warning still closes the reported gap: `verify` and `doctor` used to print
    // a clean bill of health on a tree that cannot deploy, and now they say so.
    // The authoritative check remains wrangler's own, which `lunora build` runs.
    report.warnings.push(...collectUnexportedClassErrors(resolvedWrangler, options.projectRoot, wranglerPath));

    // FS-aware: `assets.directory` is created by the client build, so it may
    // legitimately not exist at validation time (pre-build). Surface a *warning*
    // (never an error) so pre-build validation flows aren't broken — mirrors the
    // container-image existence check above, but downgraded to a warning.
    const assetsDirectory = resolvedWrangler.assets?.directory;

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
