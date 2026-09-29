/** Resolving the `--env` view of a wrangler config: which keys an environment inherits from the top level and which it must redeclare. */

import type { WranglerConfig } from "./wrangler-config";

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
    "containers",
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

export type { WranglerEnvironmentMerge };
// `mergeWranglerEnvironment` is exported so `lunora deploy`'s read-only
// preflights (D1 placeholder, localhost origin, container Docker) inspect the
// same `--env` view wrangler will deploy. Reading the top level there let an
// env-scoped placeholder / loopback origin ship silently, and falsely blocked
// the reverse layout.
export { mergeWranglerEnvironment };
