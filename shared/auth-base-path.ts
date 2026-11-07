/**
 * Where `@lunora/auth` serves its routes, for the packages that must know without
 * importing it. `@lunora/config` routes these paths to the Worker ahead of the
 * static assets (`assets.run_worker_first`) but cannot import `@lunora/auth`,
 * which depends on it, so both read them here.
 */

/**
 * Default basePath used by better-auth's client + handler. Override via the
 * second argument of `handleAuthRequest` if you mount the auth routes somewhere
 * else.
 */
export const DEFAULT_AUTH_BASE_PATH: string = "/api/auth";

/** RFC 9728 protected-resource metadata; the resource's path follows it. Served outside the base path. */
export const PROTECTED_RESOURCE_PREFIX: string = "/.well-known/oauth-protected-resource";

/** RFC 8414 authorization-server metadata; the issuer's path follows it. Served outside the base path. */
export const AUTHORIZATION_SERVER_PREFIX: string = "/.well-known/oauth-authorization-server";
