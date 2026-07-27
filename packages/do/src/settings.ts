import type { DeployInfo, SettingEntry, SettingsResult } from "@lunora/shard-engine";

/**
 * Names that, by convention, hold a secret regardless of the value's shape. A
 * binding/var whose name matches (case-insensitively) is classified `secret` and
 * its value is always masked — the studio is admin-gated, but raw secrets
 * still never cross the wire.
 */
const SECRET_NAME_PATTERN = /key|secret|token|password|passwd|credential|private|auth|bearer|session|cookie|salt|signature|dsn|webhook/iu;

/**
 * Reserved Lunora control vars that aren't application config and shouldn't be
 * surfaced as ordinary settings rows. They're either secrets the framework owns
 * (`LUNORA_ADMIN_TOKEN`, `LUNORA_WS_BEARER`) — which, if ever shown, are masked
 * anyway via {@link SECRET_NAME_PATTERN} — or plumbing. Listed here so the view
 * stays focused on the user's own deployment config.
 */
const LUNORA_INTERNAL_VARS = new Set<string>(["LUNORA_ADMIN_TOKEN", "LUNORA_WS_BEARER"]);

/** Vars whose value is a public deployment URL, surfaced in {@link DeployInfo.workerUrl}. */
const WORKER_URL_VARS = ["CF_PAGES_URL", "WORKER_URL", "LUNORA_WORKER_URL"] as const;

/** Vars whose value names the Cloudflare environment, surfaced in {@link DeployInfo.environment}. */
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "WORKER_ENV", "NODE_ENV"] as const;

/**
 * Mask a string value for display. Mirrors the CLI's `env` redaction: short
 * values collapse to `****`; longer ones keep their first four characters and
 * replace the tail with bullets (bounded to eight), giving a recognisable
 * prefix without leaking the secret. Never returns the raw value.
 */
const redact = (value: string): string => {
    if (value.length <= 4) {
        return "••••";
    }

    return `${value.slice(0, 4)}${"•".repeat(Math.min(8, value.length - 4))}`;
};

/** True when a name conventionally denotes a secret (case-insensitive). */
const looksSecret = (name: string): boolean => SECRET_NAME_PATTERN.test(name);

/**
 * Classify a non-string binding object into a coarse runtime kind for the UI
 * label. Cloudflare bindings are opaque proxies, so we sniff well-known method
 * shapes (R2's `get`/`put`/`list`, KV's `getWithMetadata`, a DO namespace's
 * `idFromName`, D1's `prepare`, a queue's `send`, a service's `fetch`) rather
 * than rely on a class name. Falls back to `object` when nothing matches.
 */
const bindingType = (value: object): string => {
    const has = (key: string): boolean => typeof (value as Record<string, unknown>)[key] === "function";

    if (has("idFromName") || has("idFromString")) {
        return "durable-object";
    }

    if (has("createMultipartUpload") || (has("put") && has("get") && has("list") && has("head"))) {
        return "r2";
    }

    if (has("getWithMetadata")) {
        return "kv";
    }

    if (has("prepare") && has("dump")) {
        return "d1";
    }

    if (has("send") && has("sendBatch")) {
        return "queue";
    }

    if (has("fetch") && !has("get")) {
        return "service";
    }

    return "object";
};

/**
 * Pull best-effort deploy metadata from well-known vars/bindings in `env`. Reads
 * only what the runtime happens to expose and omits everything else — no
 * guessing. `CF_VERSION_METADATA` is the Worker version-metadata binding
 * (`{ id, tag, timestamp }`) when configured.
 */
const readDeployInfo = (env: Record<string, unknown>): DeployInfo => {
    const deploy: DeployInfo = {};

    for (const key of WORKER_URL_VARS) {
        if (typeof env[key] === "string" && env[key] !== "") {
            deploy.workerUrl = env[key];

            break;
        }
    }

    for (const key of ENVIRONMENT_VARS) {
        if (typeof env[key] === "string" && env[key] !== "") {
            deploy.environment = env[key];

            break;
        }
    }

    const versionMetadata = env["CF_VERSION_METADATA"];

    if (versionMetadata !== null && typeof versionMetadata === "object") {
        const meta = versionMetadata as Record<string, unknown>;

        if (typeof meta["id"] === "string") {
            deploy.deploymentId = meta["id"];
        }

        if (typeof meta["tag"] === "string") {
            deploy.versionTag = meta["tag"];
        }
    }

    return deploy;
};

/** Environment-name values that denote a development deployment (where the request log may capture raw, un-redacted args). Anchored so `production`/`staging` never match. */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;

/**
 * Whether the worker is running in a development environment, derived from the
 * same `CF_ENV`/`ENVIRONMENT`/`WORKER_ENV`/`NODE_ENV` vars the Settings view
 * surfaces. Used to decide whether the request log captures raw args/identity
 * (dev) or redacts them (prod — PLAN3 §3.3 PII open question).
 *
 * Defaults to FALSE (production-safe): a real deploy that sets none of these
 * vars is treated as production and stays redacted. Only an explicit dev-like
 * value (`development`, `local`, `test`, …) — which the lunora dev server sets —
 * flips it on, so PII can never leak from a misdetected production environment.
 */
const isDevEnvironment = (rawEnv: unknown): boolean => {
    const env = (rawEnv ?? {}) as Record<string, unknown>;

    for (const key of ENVIRONMENT_VARS) {
        const value = env[key];

        if (typeof value === "string" && DEV_ENVIRONMENT_PATTERN.test(value)) {
            return true;
        }
    }

    return false;
};

/**
 * Build the read-only settings view from the Worker `env`. String entries are
 * classified `secret` (masked, name- or framework-driven) or `var` (masked
 * preview); every non-string binding becomes a `binding` entry exposing only its
 * name and a coarse {@link bindingType}. Reserved Lunora control vars are
 * skipped. Entries are sorted by name for a stable table. The raw value of a
 * secret is **never** included.
 */
const buildSettings = (rawEnv: unknown): SettingsResult => {
    const env = (rawEnv ?? {}) as Record<string, unknown>;
    const settings: SettingEntry[] = [];

    for (const [name, value] of Object.entries(env)) {
        if (LUNORA_INTERNAL_VARS.has(name)) {
            continue;
        }

        if (typeof value === "string") {
            const secret = looksSecret(name);

            settings.push({
                kind: secret ? "secret" : "var",
                name,
                // Both vars and secrets are masked — a "var" may still hold a
                // sensitive value, and the studio never needs the raw text.
                value: redact(value),
            });

            continue;
        }

        if (typeof value === "number" || typeof value === "boolean") {
            settings.push({ kind: "var", name, value: String(value) });

            continue;
        }

        if (value !== null && typeof value === "object") {
            // eslint-disable-next-line unicorn/no-null -- explicit JSON wire value: a binding has no string preview
            settings.push({ bindingType: bindingType(value), kind: "binding", name, value: null });

            continue;
        }

        // null/undefined/function: surface the name with no value.
        // eslint-disable-next-line unicorn/no-null -- explicit JSON wire value: this entry has no string preview
        settings.push({ kind: "var", name, value: null });
    }

    settings.sort((a, b) => a.name.localeCompare(b.name));

    return { deploy: readDeployInfo(env), settings };
};

export { bindingType, buildSettings, isDevEnvironment, looksSecret, readDeployInfo, redact };
