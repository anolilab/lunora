/**
 * Shared wrangler.jsonc validator used by both the Vite plugin
 * (`@cirrus/vite`) and the CLI (`@cirrus/cli`).
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
import { existsSync } from "node:fs";
import { dirname } from "node:path";

import join from "./path";
import type { SchemaInfo } from "./schema-info";
import { discoverSchemaInfo } from "./schema-info";
import { findWranglerFile, readWranglerJsonc } from "./wrangler-path";

const REQUIRED_COMPATIBILITY_DATE: string = "2026-04-07";

const REQUIRED_FLAG: string = "web_socket_auto_reply_to_close";

// Hoisted to module scope so the literal isn't re-compiled on every call.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface WranglerDurableObjectBinding {
    class_name?: string;
    name?: string;
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

interface WranglerConfig {
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; `validateContainers` guards against that at runtime.
    containers?: ReadonlyArray<WranglerContainerEntry | null | undefined>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
    migrations?: ReadonlyArray<{ new_classes?: ReadonlyArray<string>; new_sqlite_classes?: ReadonlyArray<string> } | null | undefined>;
    observability?: { enabled?: boolean };
    r2_buckets?: ReadonlyArray<{ binding?: string }>;
    // Parsed from untrusted JSONC, so individual entries may be `null` or
    // otherwise malformed; the validators below guard against that at runtime.
    tail_consumers?: ReadonlyArray<TailConsumer | null | undefined>;
    vectorize?: ReadonlyArray<{ binding?: string; index_name?: string } | null | undefined>;
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
            `${label} class "${entry.class_name}" has no matching durable_objects binding — run \`cirrus dev\` to auto-reconcile wrangler.jsonc, or add { "name": "...", "class_name": "${entry.class_name}" }`,
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

    const boundClasses = new Set((wrangler.durable_objects?.bindings ?? []).map((binding) => binding.class_name));
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

    const durableObjectBindings = wrangler.durable_objects?.bindings ?? [];
    const shardBinding = durableObjectBindings.find((binding) => binding.name === "SHARD" && binding.class_name === "ShardDO");

    if (!shardBinding) {
        errors.push(
            'durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" } — run `cirrus dev` to auto-reconcile wrangler.jsonc, or add the binding manually',
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

    // `web_socket_auto_reply_to_close` became the default on 2026-04-07, the
    // same date REQUIRED_COMPATIBILITY_DATE enforces — so requiring it
    // explicitly is redundant and workerd now warns when it's set. Any
    // compatibility_date that would have made the flag mandatory already trips
    // the `>= REQUIRED_COMPATIBILITY_DATE` error above, so a separate flag error
    // adds no signal. We therefore neither require nor reject the flag here.

    if (schema?.hasGlobalTable) {
        const d1Bindings = wrangler.d1_databases ?? [];
        const databaseBinding = d1Bindings.find((binding) => binding.binding === "DB");

        if (!databaseBinding) {
            errors.push(
                'schema declares .global() tables; d1_databases must include a binding named "DB" — run `cirrus dev` to auto-reconcile wrangler.jsonc, or add the binding manually',
            );
        }
    }

    validateVectorizeBindings(wrangler, schema?.vectorIndexNames ?? [], errors);
    validateTailConsumers(wrangler, errors);
    validateContainers(wrangler, errors, warnings);

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
 * File-system aware variant: reads `wrangler.jsonc`/`wrangler.json` from
 * the given project root, discovers the schema (if any), and delegates to
 * `validateWranglerConfig`. Returns the legacy
 * `{ problems, wranglerPath }` shape plus the structured `report`.
 */
const validateWranglerProject = (options: WranglerProjectValidationOptions): WranglerProjectValidationResult => {
    const schemaDirectory = options.schemaDir ?? "cirrus";
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

    for (const entry of wrangler.containers ?? []) {
        const image = entry?.image;

        if (typeof image !== "string" || !(image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile"))) {
            continue;
        }

        if (!existsSync(image.startsWith("/") ? image : join(configDirectory, image))) {
            report.errors.push(
                `containers image "${image}" does not exist (resolved relative to ${wranglerPath}); create the Dockerfile or point image at a registry reference`,
            );
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
};
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWrangler, validateWranglerConfig, validateWranglerProject, withTailConsumer };
