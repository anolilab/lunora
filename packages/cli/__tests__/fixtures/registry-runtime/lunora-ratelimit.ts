/**
 * Runtime stand-in for `@lunora/ratelimit`, which this package does not depend on.
 * Limits never trip: the items under test are exercised for what they write, and
 * the middleware is the identity because the builder stub ignores `.use(...)`.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
class RateLimiter {}

const createDbStore = (): object => ({});

const createMemoryStore = (): object => ({});

const rateLimit = (): object => ({});

export { createDbStore, createMemoryStore, RateLimiter, rateLimit };
