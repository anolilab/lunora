import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig, coverageConfigDefaults } from "vitest/config";

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
 * Two-project Vitest config (matches @lunora/scheduler / @lunora/client):
 *
 *  - `mocks`   — fast unit suite over in-memory R2 fakes, plain Node, always on.
 *  - `workerd` — Phase 6 verification gate. Spins up workerd with a real R2
 *               binding via Miniflare's emulator. Gated by `LUNORA_WORKERD_TESTS=1`
 *               because the pool needs unrestricted localhost-loopback between
 *               workerd and the test host — sandboxed CI blocks that. Locally:
 *
 *                   LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/storage test
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
