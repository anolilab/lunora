/**
 * Runtime stand-in for `cloudflare:workers`, whose `env` export only exists
 * inside the Workers runtime. A test populates the bindings it needs on this
 * object before invoking a registry item.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
const env: Record<string, unknown> = {};

export { env };
