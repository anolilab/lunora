/**
 * Runtime stand-in for `better-auth/api`, which the saas template's
 * `lunora/auth/index.ts` imports for the `APIError` its invitation hook throws.
 * better-auth is not a dependency of this package; the suites that load that file
 * never reach the hook, so the class only has to exist.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
class APIError extends Error {}

export { APIError };
