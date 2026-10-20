/** Env-name values that mark a development deployment (`lunora dev` sets `WORKER_ENV=development`). */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Whether the Worker is running in development: at least one of `CF_ENV`,
 * `ENVIRONMENT`, `NODE_ENV` or `WORKER_ENV` is set, and EVERY one that is set
 * names a dev environment. A set-but-empty var counts as set, so it vetoes dev.
 * `@lunora/mail`, `@lunora/queue` and `@lunora/shard-engine` still treat an empty
 * var as unset; this copy is stricter on purpose.
 *
 * `every`, not `some`: a production deploy that also carries a leftover dev
 * `NODE_ENV` must stay production, or it would log auth links (bearer
 * credentials) and run migrations on cold start. A deploy that sets none of the
 * vars is production too — fail closed either way.
 */
const isDevEnvironment = (env: Record<string, unknown>): boolean => {
    // A recognised var holding a non-string or an empty value is still SET: it vetoes dev rather than being skipped.
    const values = ENVIRONMENT_VARS.map((key) => env[key]).filter((value) => value !== undefined);

    return values.length > 0 && values.every((value) => typeof value === "string" && DEV_ENVIRONMENT_PATTERN.test(value));
};

export default isDevEnvironment;
