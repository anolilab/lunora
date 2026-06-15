import { defineConfig, coverageConfigDefaults } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers
// pool relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-pool-workers` projects), so coverage is wired inline here.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "__fixtures__/**",
        "__bench__/**",
        "scripts/**",
        "src/**/types.ts",
        "src/module.d.ts",
        "src/reset.d.ts",
        "e2e",
        "**/node_modules/**",
        "**/dist/**",
    ],
};

/**
 * See `packages/do/vitest.config.ts` for the rationale behind the
 * `LUNORA_WORKERD_TESTS=1` opt-in gate.
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
