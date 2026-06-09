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

interface WranglerConfig {
    compatibility_date?: string;
    compatibility_flags?: ReadonlyArray<string>;
    d1_databases?: ReadonlyArray<{ binding?: string }>;
    durable_objects?: { bindings?: ReadonlyArray<WranglerDurableObjectBinding> };
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
        errors.push('durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" }');
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
            errors.push('schema declares .global() tables; d1_databases must include a binding named "DB"');
        }
    }

    validateVectorizeBindings(wrangler, schema?.vectorIndexNames ?? [], errors);
    validateTailConsumers(wrangler, errors);

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

    return {
        problems: report.errors,
        report,
        wranglerPath,
    };
};

export type { TailConsumer, WranglerConfig, WranglerProjectValidationOptions, WranglerProjectValidationResult, WranglerValidationReport };
export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWrangler, validateWranglerConfig, validateWranglerProject, withTailConsumer };
