/**
 * Default basePath used by better-auth's client + handler. Override via the
 * second argument of `handleAuthRequest` if you mount the auth routes somewhere
 * else.
 *
 * `@lunora/config`
 * routes it to the Worker ahead of the static assets (`assets.run_worker_first`)
 * but cannot import `@lunora/auth`, which depends on it, so both read it here.
 */
export const DEFAULT_AUTH_BASE_PATH: string = "/api/auth";
