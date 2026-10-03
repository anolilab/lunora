/**
 * Validating a wrangler config's non-binding settings: limits, placement,
 * observability, cache, exports, assets, tail consumers, CORS and the scheduler
 * origin.
 */

import { isEnvEnabled } from "../../../../shared/env-flag";
import { isNonEmptyString, isPlainObject } from "./guards";
import { objectBindingEntries } from "./validate-bindings";
import type { TailConsumer, WranglerConfig } from "./wrangler-config";

/** Push an error when a set value is not a boolean; `hint` adds a parenthesised remedy. */
const checkBoolean = (value: unknown, path: string, errors: string[], hint?: string): void => {
    if (value !== undefined && typeof value !== "boolean") {
        errors.push(`${path} must be a boolean${hint === undefined ? "" : ` (${hint})`}`);
    }
};

/** Push an error when a set value is not a `head_sampling_rate`-style fraction in [0, 1]. */
const checkSamplingRate = (rate: unknown, path: string, errors: string[]): void => {
    if (rate !== undefined && (typeof rate !== "number" || Number.isNaN(rate) || rate < 0 || rate > 1)) {
        errors.push(`${path} must be a number in [0, 1] (the fraction of requests sampled)`);
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
    checkBoolean(wrangler.logpush, "logpush", errors, 'set "logpush": true to enable Cloudflare Logpush');
};

/**
 * `secrets.required` lists the secret names the Worker needs. Wrangler loads
 * only those keys from `.dev.vars` and blocks a deploy while one is unset, so a
 * malformed list is not cosmetic — it changes which secrets the Worker sees.
 */
const validateSecretsRequired = (wrangler: WranglerConfig, errors: string[]): void => {
    const value: unknown = wrangler.secrets;

    if (value === undefined) {
        return;
    }

    const required: unknown = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as { required?: unknown }).required : undefined;

    if (!Array.isArray(required) || required.some((name) => typeof name !== "string" || name === "")) {
        errors.push('secrets must be an object whose "required" is an array of secret names (e.g. { "required": ["API_KEY"] })');
    }
};

/** Cloudflare's own ceiling on `limits.cpu_ms`; a value above it is rejected at deploy rather than clamped. */
const MAX_CPU_MS = 300_000;

/**
 * `limits` bounds a Worker's runtime consumption — today just `cpu_ms`.
 *
 * Worth validating rather than ignoring because it is a GUARDRAIL, and a
 * guardrail that silently isn't applied is worse than none: alerting is lagging
 * by definition, so the cap is what actually bounds the blast radius of a
 * runaway handler or a retry storm while a human is still reading the alert. A
 * mistyped `cpu_ms` (or a `limits` block wrangler drops) leaves the deployment
 * uncapped while the config reads as though it isn't.
 */
const validateLimits = (wrangler: WranglerConfig, errors: string[]): void => {
    const { limits } = wrangler;

    if (limits === undefined) {
        return;
    }

    if (typeof limits !== "object" || Array.isArray(limits)) {
        errors.push('limits must be an object (e.g. { "cpu_ms": 30000 })');

        return;
    }

    const cpuMs = limits.cpu_ms;

    if (cpuMs === undefined) {
        return;
    }

    if (typeof cpuMs !== "number" || !Number.isFinite(cpuMs) || !Number.isInteger(cpuMs) || cpuMs <= 0) {
        errors.push("limits.cpu_ms must be a positive integer number of milliseconds");

        return;
    }

    if (cpuMs > MAX_CPU_MS) {
        errors.push(`limits.cpu_ms must be at most ${String(MAX_CPU_MS)} (Cloudflare's per-invocation ceiling)`);
    }
};

/**
 * The `placement.mode` values wrangler's own config schema accepts:
 * `"smart"` opts into Smart Placement, `"targeted"` pins the Worker to a
 * region/host/hostname, and `"off"` disables placement for a Worker that
 * would otherwise inherit an account default. Anything else is a typo
 * wrangler drops silently.
 */
const PLACEMENT_MODES = new Set(["off", "smart", "targeted"]);

/**
 * `placement` is Smart/targeted Placement config. Recognizing the mode catches a
 * typo (`"smrat"`) wrangler would silently drop, without hard-blocking the two
 * non-smart modes wrangler accepts. Placement is opt-in only and never
 * auto-injected (it can regress geo-distributed latency for a DO/D1-centric app).
 */
const validatePlacement = (wrangler: WranglerConfig, errors: string[]): void => {
    // `unknown`, for the same reason as `validateSelfDescribingBinding`: this is
    // hand-edited JSONC, not a value TypeScript has vouched for.
    const { placement }: { placement?: unknown } = wrangler;

    if (placement === undefined) {
        return;
    }

    if (typeof placement !== "object" || placement === null || Array.isArray(placement)) {
        errors.push('placement must be an object (e.g. { "mode": "smart" })');

        return;
    }

    const { mode } = placement as { mode?: unknown };

    if (mode !== undefined && (typeof mode !== "string" || !PLACEMENT_MODES.has(mode))) {
        errors.push(`placement.mode must be one of ${[...PLACEMENT_MODES].map((value) => `"${value}"`).join(", ")}`);
    }
};

/**
 * What one key of an `observability` level holds: a boolean (with an optional
 * remedy for the error), a 0–1 sampling rate, a list of OpenTelemetry export
 * destination names, or a nested level.
 */
type ObservabilityField =
    | { readonly hint?: string; readonly kind: "boolean" }
    | { readonly kind: "destinations" }
    | { readonly kind: "level"; readonly level: ObservabilityLevel }
    | { readonly kind: "samplingRate" };

/**
 * One level of the `observability` block: every key wrangler documents for it,
 * and what each holds. The descriptor IS the known-key set — anything not in it
 * is almost always a typo (`head_sample_rate`, `destination`) that wrangler
 * would drop silently.
 */
type ObservabilityLevel = Readonly<Record<string, ObservabilityField>>;

const BOOLEAN_FIELD: ObservabilityField = { kind: "boolean" };
const SAMPLING_RATE_FIELD: ObservabilityField = { kind: "samplingRate" };

/**
 * The documented `observability` block, one descriptor per level — mirrors
 * wrangler's own config schema (`Observability` in `config-schema.json`;
 * developers.cloudflare.com/workers/wrangler/configuration/#observability and
 * …/observability/opentelemetry-export/). `traces` takes the export knobs
 * (`destinations`, `persist`) and its own rate; `logs` adds `invocation_logs`,
 * the per-invocation summary line (status, duration, outcome) the Workers Logs
 * Query Builder groups on.
 */
const OBSERVABILITY_TRACES: ObservabilityLevel = {
    destinations: { kind: "destinations" },
    enabled: BOOLEAN_FIELD,
    head_sampling_rate: SAMPLING_RATE_FIELD,
    persist: BOOLEAN_FIELD,
};

const OBSERVABILITY_LOGS: ObservabilityLevel = {
    ...OBSERVABILITY_TRACES,
    invocation_logs: { hint: 'set "invocation_logs": true to keep per-invocation summaries', kind: "boolean" },
};

const OBSERVABILITY: ObservabilityLevel = {
    enabled: BOOLEAN_FIELD,
    head_sampling_rate: SAMPLING_RATE_FIELD,
    issues: { kind: "level", level: { enabled: BOOLEAN_FIELD } },
    logs: { kind: "level", level: OBSERVABILITY_LOGS },
    redact_query_string: BOOLEAN_FIELD,
    traces: { kind: "level", level: OBSERVABILITY_TRACES },
};

/** Type-check one non-level `observability` value against its descriptor field. */
const checkObservabilityLeaf = (field: Exclude<ObservabilityField, { kind: "level" }>, value: unknown, path: string, errors: string[]): void => {
    switch (field.kind) {
        case "boolean": {
            checkBoolean(value, path, errors, field.hint);
            break;
        }
        case "destinations": {
            if (value !== undefined && (!Array.isArray(value) || value.some((destination) => !isNonEmptyString(destination)))) {
                errors.push(`${path} must be an array of destination names configured in the Cloudflare dashboard`);
            }

            break;
        }
        case "samplingRate": {
            checkSamplingRate(value, path, errors);
            break;
        }
        default: {
            break;
        }
    }
};

/**
 * Walk one `observability` level against its descriptor: a known key is
 * type-checked (recursing into a nested level), an unknown one warns.
 *
 * Unknown keys warn rather than fail: Cloudflare keeps adding keys to this
 * block (`traces`, `issues`, `redact_query_string`), and a hard error would
 * block a deploy on a key wrangler accepts before this descriptor catches up.
 */
const walkObservabilityLevel = (block: Record<string, unknown>, level: ObservabilityLevel, path: string, errors: string[], warnings: string[]): void => {
    for (const [key, value] of Object.entries(block)) {
        // `Object.hasOwn`, not a bare lookup: a hand-typed `"constructor"` key
        // would otherwise resolve to `Object.prototype`'s and skip the warning.
        const field = Object.hasOwn(level, key) ? level[key] : undefined;
        const keyPath = `${path}.${key}`;

        if (field === undefined) {
            warnings.push(
                `${keyPath} is not a documented wrangler key (expected one of ${Object.keys(level).join(", ")}) — a typo is silently ignored by wrangler`,
            );
        } else if (field.kind !== "level") {
            checkObservabilityLeaf(field, value, keyPath, errors);
        } else if (isPlainObject(value)) {
            walkObservabilityLevel(value, field.level, keyPath, errors, warnings);
        } else if (value !== undefined) {
            errors.push(`${keyPath} must be an object`);
        }
    }
};

/**
 * `observability` enables Workers Logs + Traces. Shape-check the block against
 * {@link OBSERVABILITY} so a mistyped value is an error and a typo'd key a
 * warning before deploy, instead of being silently ignored by wrangler.
 */
const validateObservability = (wrangler: WranglerConfig, errors: string[], warnings: string[]): void => {
    // `unknown`: hand-edited JSONC, not a value TypeScript has vouched for.
    const { observability }: { observability?: unknown } = wrangler;

    if (observability === undefined) {
        return;
    }

    if (!isPlainObject(observability)) {
        errors.push('observability must be an object (e.g. { "enabled": true, "head_sampling_rate": 1 })');

        return;
    }

    walkObservabilityLevel(observability, OBSERVABILITY, "observability", errors, warnings);
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

    if (!isPlainObject(cache)) {
        errors.push('cache must be an object (e.g. { "enabled": true })');

        return;
    }

    checkBoolean(cache.enabled, "cache.enabled", errors);
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
 * Whether this config declares the `SchedulerDO` in THIS script.
 *
 * A binding carrying `script_name` names a class in ANOTHER Worker, whose env
 * owns it; same carve-out as the migration and unexported-class checks.
 *
 * Deliberately NOT the class-A `ctx.scheduler` opt-in: this reads the `--env`
 * MERGED view, `durable_objects` is non-inheritable, and `@lunora/vite` has no
 * `--env` to read — so an env-scoped binding made the two disagree about what
 * the entry exports. The generated `scheduler` module is that signal instead.
 */
const declaresSchedulerDurableObject = (wrangler: WranglerConfig): boolean =>
    objectBindingEntries(wrangler.durable_objects?.bindings).some((binding) => binding.class_name === "SchedulerDO" && binding.script_name === undefined);

/** The `vars` key the SchedulerDO reads its dispatch origin from — see {@link validateSchedulerOrigin}. */
const SCHEDULER_ORIGIN_VAR = "LUNORA_ORIGIN_URL";

/**
 * A declared `SchedulerDO` with no `LUNORA_ORIGIN_URL` cannot dispatch anything.
 *
 * The DO takes its callback origin from its OWN env — never from the schedule
 * request, which would be an SSRF vector — and refuses to enqueue without it
 * (`ORIGIN_NOT_CONFIGURED`). Nothing provisions the var: `reconcileDurableObjects`
 * writes the SCHEDULER binding off a bare `export { SchedulerDO }` and writes no
 * `vars`, and no scaffolder produces this key. So an app reaches production with
 * every `ctx.scheduler.runAfter` failing, discovered only when some unrelated
 * procedure first schedules — nowhere near the cause.
 *
 * A WARNING, and for the same reason as the unexported-class check below: `vars`
 * is a PARTIAL view of the Worker env. It cannot see a `wrangler secret put`
 * value (which `lunora deploy` itself recommends for this key), a var set in the
 * dashboard, or another Worker's env. Each of those fails CLOSED, so erroring
 * would block a deploy that works — or kill the dev server on the very run in
 * which Lunora auto-wrote the binding. The reported problem was silence, not
 * permissiveness, and a warning ends the silence.
 *
 * A binding carrying `script_name` names a class in ANOTHER Worker, whose env
 * owns the var; same carve-out as the migration and unexported-class checks.
 */
const validateSchedulerOrigin = (wrangler: WranglerConfig, environment: string | undefined, warnings: string[]): void => {
    if (!declaresSchedulerDurableObject(wrangler) || isNonEmptyString(wrangler.vars?.[SCHEDULER_ORIGIN_VAR])) {
        return;
    }

    // `vars` is non-inheritable, so under `--env <name>` the top-level block is
    // NOT what wrangler ships — naming the bare key would send the reader to a
    // `vars` block that already has it.
    const scope = environment === undefined ? "vars" : `env.${environment}.vars`;
    // Secrets are non-inheritable exactly like `vars`, so the fallback remedy has
    // to name the same environment the warning is about — an unscoped
    // `secret put` writes the top-level worker and leaves this one untouched.
    const secretPut = environment === undefined ? "" : ` --env ${environment}`;

    warnings.push(
        `durable_objects.bindings declares the SchedulerDO but ${scope}.${SCHEDULER_ORIGIN_VAR} is unset — the DO reads its dispatch origin from its own env and refuses to schedule without it, so every ctx.scheduler.runAfter/runAt fails with ORIGIN_NOT_CONFIGURED. Set ${scope}.${SCHEDULER_ORIGIN_VAR} to the worker's public URL, or \`wrangler secret put ${SCHEDULER_ORIGIN_VAR}${secretPut}\` (ignore this if it is already set as a secret or in the dashboard).`,
    );
};

export {
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
    withTailConsumer,
};
