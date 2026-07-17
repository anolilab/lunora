import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers
// pool relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-pool-workers` projects), so coverage is wired inline here.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [...(coverageConfigDefaults.exclude ?? []), "__fixtures__/**", "src/**/types.ts", "**/node_modules/**", "**/dist/**"],
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the
 * rationale behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `mocks`   — Node unit suite over plain-object queue doubles. Always on.
 *  - `workerd` — real workerd via `@cloudflare/vitest-pool-workers`: the typed
 *                `ctx.queues` producer against a real `Queue` binding and the
 *                generated `queue()` push-consumer dispatch over a real
 *                `MessageBatch` (see `__tests__/workerd/`).
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

export default defineConfig({
    test: {
        coverage,
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: { name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] },
                  },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { name: "workerd", include: ["__tests__/workerd/**/*.test.ts"] },
                  },
              ]
            : [
                  {
                      extends: true,
                      test: { name: "mocks", environment: "node", include: ["__tests__/*.test.ts"] },
                  },
              ],
    },
});
