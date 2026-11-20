/**
 * The wrangler config rules `lunora dev --target node` and `lunora deploy --target node` share: what a binding may be named,
 * which declared sections the Node host composes, and the `WORKER_ENV` it sets itself. One copy, so the dev host and the
 * container refuse and report the same config the same way.
 */

/** What the host tells the app it runs as: `development` under `lunora dev`, `production` in the deployed container. */
const WORKER_ENV = "WORKER_ENV";

/**
 * Wrangler's rule for a binding name: a JavaScript identifier. A Durable Object binding's name is also a directory under the
 * host's data directory, so anything else (`..`, `a/b`) could put shard files outside it.
 */
const BINDING_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * Top-level wrangler keys the Node host composes, or that configure the Worker rather than bind something into `env`. Every
 * other declared key is reported as unbound: an allowlist, so a binding section wrangler adds later is named rather than
 * silently missing. `durable_objects` is checked per binding, since one bound to another worker's class is unbound.
 */
const COMPOSED_OR_CONFIG_KEYS: ReadonlySet<string> = new Set([
    "$schema",
    "account_id",
    "alias",
    "base_dir",
    "build",
    "cache",
    "compatibility_date",
    "compatibility_flags",
    "define",
    "dev",
    "durable_objects",
    "env",
    "find_additional_modules",
    "first_party_worker",
    "hyperdrive",
    "jsx_factory",
    "jsx_fragment",
    "keep_names",
    "keep_vars",
    "legacy_env",
    "limits",
    "logpush",
    "main",
    "migrations",
    "minify",
    "name",
    "no_bundle",
    "node_compat",
    "observability",
    "placement",
    "preserve_file_names",
    "preview_urls",
    "route",
    "routes",
    "rules",
    "secrets",
    "secrets_store_secrets",
    "send_metrics",
    "streaming_tail_consumers",
    "tail_consumers",
    "triggers",
    "tsconfig",
    "upload_source_maps",
    "usage_model",
    "vars",
    "workers_dev",
]);

/** Whether a declared section binds anything: an empty list or object is no binding. */
const isDeclared = (value: unknown): boolean => {
    if (Array.isArray(value)) {
        return value.length > 0;
    }

    if (typeof value === "object" && value !== null) {
        return Object.keys(value).length > 0;
    }

    return value !== undefined && value !== null;
};

/** The declared top-level sections of a wrangler config (or one environment's view of it) that the Node host leaves unbound. */
const unboundSections = (config: Readonly<Record<string, unknown>>): string[] =>
    Object.keys(config).filter((key) => !COMPOSED_OR_CONFIG_KEYS.has(key) && isDeclared(config[key]));

/**
 * The host sets `WORKER_ENV` itself. A var, secret or binding of that name would replace it on `env`, and the app would no
 * longer see the mode it runs in: a container that reads `development` turns on development-only behaviour, such as mail
 * capture, in production, and a dev host that reads a binding object turns it off.
 */
const refuseWorkerEnvOverride = (
    sources: ReadonlyArray<{ names: ReadonlyArray<string>; source: string }>,
    configName: string,
    mode: "development" | "production",
): void => {
    const setBy = sources.filter(({ names }) => names.includes(WORKER_ENV)).map(({ source }) => source);

    if (setBy.length === 0) {
        return;
    }

    const consequence =
        mode === "production"
            ? `a ${WORKER_ENV} of development turns on development-only behaviour, such as mail capture, in production`
            : `the binding would replace it on env, and the app would no longer see that it runs in development`;

    throw new Error(`--target node sets ${WORKER_ENV} to ${mode} itself, and ${configName} also declares it in ${setBy.join(", ")}. Remove it: ${consequence}`);
};

export { BINDING_NAME, isDeclared, refuseWorkerEnvOverride, unboundSections, WORKER_ENV };
