/**
 * Standalone Vitest config for the wave-11 spike prototypes (plans 110 / 111 / 113).
 *
 * These prototypes deliberately live OUTSIDE the pnpm workspace (`plans/` is not a
 * workspace glob) so they add no package, no `pnpm-workspace.yaml` override, and no
 * build step. They exercise pure composition logic with in-memory doubles; the
 * RAG prototype imports the *real* `@lunora/bindings/vectors` `createVectors` by
 * relative source path (it only imports its own relative siblings, so Vitest's
 * esbuild transform resolves it with no build).
 *
 * Run from this directory:  `pnpm exec vitest run --config vitest.config.ts`
 */
export default {
    test: {
        environment: "node",
        include: ["**/*.test.ts"],
        watch: false,
    },
};
