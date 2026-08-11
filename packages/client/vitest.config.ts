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
        // Real gap (measured ~11% stmts / 6% branches), not a floor evasion — service-worker
        // testing needs an environment decision (fake-indexeddb + a ServiceWorkerGlobalScope
        // shim, or a workerd-style pool) this plan doesn't make. Excluded from the denominator
        // so it doesn't set a floor that later sw work has to fight; see plans/324.
        "src/sw/**",
    ],
    // Deliberate floor, pinned just under measured (with `src/sw/**` excluded above) so it
    // catches regressions without redding on arrival. Inline (not `tools/get-vitest-config`)
    // because the workers pool needs `defineConfig` directly — see the file-level comment.
    thresholds: {
        branches: 75,
        functions: 76,
        lines: 84,
        statements: 84,
    },
};

/**
 * Two-project Vitest config:
 *
 *  - `mocks`   — fast unit suite over fake WebSocket / fetch doubles, plain
 *               Node, always enabled.
 *  - `workerd` — Phase 3 verification gate. Spins up a real workerd via
 *               `@cloudflare/vitest-pool-workers`, mounts `@lunora/runtime` on
 *               top of `ShardDO`, and drives the standalone `LunoraClient`
 *               through `SELF.fetch`. Gated by `LUNORA_WORKERD_TESTS=1`
 *               because the pool needs unrestricted localhost-loopback
 *               between workerd and the test host — sandboxed CI blocks
 *               that. On a developer workstation:
 *
 *                   LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/client test
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

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
