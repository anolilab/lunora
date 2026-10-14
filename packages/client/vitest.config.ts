import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig, coverageConfigDefaults } from "vitest/config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers
// pool relies on `defineConfig` (not the shared helper, which would break the
// `@cloudflare/vitest-plugin` projects), so coverage is wired inline here.
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
    // lines/statements carry ~1pp of margin below the ~84.1%/84.3% measured on Node 24:
    // v8 coverage instrumentation varies ~0.15pp between the Node 22 (CI) and Node 24
    // (local) legs on this file, so a floor pinned tight to one leg's number reds on the
    // other — see PR #408, where 84 passed locally (Node 24, 84.04%) and failed in CI
    // (Node 22.15, 83.89%) on the identical commit.
    thresholds: {
        branches: 75,
        functions: 76,
        lines: 83,
        statements: 83,
    },
};

/**
 * Two-project Vitest config:
 *
 *  - `mocks`   — fast unit suite over fake WebSocket / fetch doubles, plain
 *               Node, always enabled.
 *  - `workerd` — Phase 3 verification gate. Spins up a real workerd via
 *               `@cloudflare/vitest-plugin`, mounts `@lunora/runtime` on
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
