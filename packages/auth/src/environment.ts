/** Env-name values that mark a development deployment (`lunora dev` sets `WORKER_ENV=development`). */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Whether the Worker is running in development: at least one of `CF_ENV`,
 * `ENVIRONMENT`, `NODE_ENV` or `WORKER_ENV` is set, and EVERY one that is set
 * names a dev environment. The same rule `@lunora/mail` uses to decide capture.
 *
 * `every`, not `some`: a production deploy that also carries a leftover dev
 * `NODE_ENV` must stay production, or it would log auth links (bearer
 * credentials) and run migrations on cold start. A deploy that sets none of the
 * vars is production too — fail closed either way.
 */
const isDevEnvironment = (env: Record<string, unknown>): boolean => {
    const values = ENVIRONMENT_VARS.map((key) => env[key]).filter((value): value is string => typeof value === "string" && value !== "");

    return values.length > 0 && values.every((value) => DEV_ENVIRONMENT_PATTERN.test(value));
};

export default isDevEnvironment;
