/**
 * Shared wrangler.jsonc validator used by both the Vite plugin
 * (`@lunora/vite`) and the CLI (`@lunora/cli`).
 *
 * Two entry points are provided:
 * - `validateWranglerConfig(wrangler, schemaInfo)` — pure: takes a parsed
 * object plus an optional schema descriptor and returns a structured
 * `{ valid, errors, warnings }` result.
 * - `validateWranglerProject({ projectRoot, schemaDir })` (`wrangler-project.ts`) — file-system
 * aware: locates `wrangler.jsonc`/`wrangler.json`, parses it, discovers
 * the project's schema, and returns the existing
 * `{ problems, wranglerPath }` shape kept for backward compatibility.
 */

import type { SchemaInfo } from "../schema-info";
import {
    HINT_BINDING_RULES,
    objectBindingEntries,
    REQUIRED_FIELD_BINDING_RULES,
    SECRETS_STORE_RULE,
    SELF_DESCRIBING_BINDING_RULES,
    validateContainers,
    validateD1Databases,
    validateDurableObjectMigrations,
    validateGlobalBackendBindings,
    validateHintBinding,
    validateQueues,
    validateRequiredFieldEntries,
    validateSelfDescribingBinding,
    validateVectorizeBindings,
    validateVpcNetworks,
    validateWorkflowSettings,
    WORKFLOWS_RULE,
} from "./validate-bindings";
import {
    validateAssets,
    validateCache,
    validateCorsVariables,
    validateExports,
    validateLimits,
    validateLogpush,
    validateObservability,
    validatePlacement,
    validateSchedulerOrigin,
    validateSecretsRequired,
    validateSendEmail,
    validateTailConsumers,
} from "./validate-settings";
import { isCacheEnabled, WORKERS_CACHE_MIN_DATE } from "./workers-cache";
import type { WranglerConfig, WranglerValidationReport } from "./wrangler-config";
import { mergeWranglerEnvironment } from "./wrangler-environment";

const REQUIRED_COMPATIBILITY_DATE: string = "2026-04-07";

const REQUIRED_FLAG: string = "web_socket_auto_reply_to_close";

// Hoisted to module scope so the literal isn't re-compiled on every call.
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
            'durable_objects.bindings must include { "name": "SHARD", "class_name": "ShardDO" } — your dev server auto-reconciles this on startup, or add the binding manually',
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

    validateGlobalBackendBindings(wrangler, schema, errors);
    validateD1Databases(wrangler, errors);
    validateVectorizeBindings(wrangler, schema?.vectorIndexNames ?? [], errors);
    validateTailConsumers(wrangler, errors);
    validateContainers(wrangler, errors, warnings);
    validateRequiredFieldEntries(wrangler.workflows, "workflows", WORKFLOWS_RULE, errors);
    validateWorkflowSettings(wrangler, errors);
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

    validateVpcNetworks(wrangler, errors);
    validateSendEmail(wrangler, errors, warnings);
    validateSecretsRequired(wrangler, errors);
    validateLogpush(wrangler, errors);
    validateLimits(wrangler, errors);
    validatePlacement(wrangler, errors);
    validateObservability(wrangler, errors);
    validateAssets(wrangler, errors);
    validateCache(wrangler, errors);
    validateExports(wrangler, errors);
    validateCorsVariables(wrangler, errors);
    validateSchedulerOrigin(wrangler, environment, warnings);

    return { errors, valid: errors.length === 0, warnings };
};

/**
 * Convenience alias matching the original task-spec signature
 * `validateWrangler(wranglerJson, schema)` returning
 * `{ valid, errors, warnings }`.
 */
const validateWrangler: typeof validateWranglerConfig = validateWranglerConfig;

export { REQUIRED_COMPATIBILITY_DATE, REQUIRED_FLAG, validateWrangler, validateWranglerConfig };
