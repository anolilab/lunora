/**
 * Runtime stand-in for the `lunora/_generated/api` codegen emits into a project,
 * which does not exist in this checkout. Only the reference path matters: the
 * items hand `internal.*` to a shard client that the tests replace.
 *
 * Wired in by `packages/cli/vitest.config.ts`'s `resolve.alias`.
 */
const internal = {};

export { internal };
