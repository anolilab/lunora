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
 * Two-project Vitest config:
 *
 *  - `mocks`   — fast unit suite over fake WebSocket / fetch doubles, plain
 *               Node, always enabled.
 *  - `workerd` — Phase 3 verification gate. Spins up a real workerd via
 *               `@cloudflare/vitest-pool-workers`, mounts `@cirrus/runtime` on
 *               top of `ShardDO`, and drives the standalone `CirrusClient`
 *               through `SELF.fetch`. Gated by `CIRRUS_WORKERD_TESTS=1`
 *               because the pool needs unrestricted localhost-loopback
 *               between workerd and the test host — sandboxed CI blocks
 *               that. On a developer workstation:
 *
 *                   CIRRUS_WORKERD_TESTS=1 pnpm --filter @cirrus/client test
 */
const runWorkerd = process.env.CIRRUS_WORKERD_TESTS === "1";

export default defineConfig({
    test: {
        coverage,
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: {
                          environment: "node",
                          exclude: ["__tests__/workerd/**"],
                          include: ["__tests__/**/*.test.ts"],
                          name: "mocks",
                      },
                  },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: {
                                  configPath: "./__tests__/workerd/wrangler.jsonc",
                              },
                          }),
                      ],
                      test: {
                          include: ["__tests__/workerd/**/*.test.ts"],
                          name: "workerd",
                      },
                  },
              ]
            : [
                  {
                      extends: true,
                      test: {
                          environment: "node",
                          exclude: ["__tests__/workerd/**"],
                          include: ["__tests__/**/*.test.ts"],
                          name: "mocks",
                      },
                  },
              ],
    },
});
