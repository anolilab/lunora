/** Env-name values that mark a development deployment (`lunora dev` sets `WORKER_ENV=development`). */
const DEV_ENVIRONMENT_PATTERN = /^(?:dev(?:elopment)?|local(?:host)?|test)$/iu;
const ENVIRONMENT_VARS = ["CF_ENV", "ENVIRONMENT", "NODE_ENV", "WORKER_ENV"] as const;

/**
 * Whether the Worker is running in development: any of `CF_ENV`, `ENVIRONMENT`,
 * `NODE_ENV` or `WORKER_ENV` names a dev environment. A deploy that sets none of
 * them is production (fail closed), so dev-only conveniences — logging auth
 * links when no mailer is set up, migrating on cold start — never reach it.
 */
const isDevEnvironment = (env: Record<string, unknown>): boolean =>
    ENVIRONMENT_VARS.some((key) => typeof env[key] === "string" && DEV_ENVIRONMENT_PATTERN.test(env[key]));

export default isDevEnvironment;
