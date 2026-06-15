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
 * Two-project Vitest config:
 *
 *  - `mocks`   — legacy mock-state suite. Runs in plain Node, no Miniflare.
 *               Always enabled.
 *  - `workerd` — real workerd + Miniflare suite via `@cloudflare/vitest-pool-workers`.
 *               Boots `__tests__/workerd/test-worker.ts` against the wrangler
 *               config in `__tests__/workerd/wrangler.jsonc`. Exercises the
 *               WebSocket Hibernation API, real `state.acceptWebSocket()`,
 *               `serializeAttachment` round-trip, and SQLite-in-DO storage.
 *
 *               Gated by `LUNORA_WORKERD_TESTS=1` because the pool-workers
 *               integration requires unrestricted localhost-loopback access
 *               between workerd and the test host. Sandboxed CI environments
 *               (including the harness this PR was authored in) block that
 *               connection and the runtime can't boot. On a developer
 *               workstation set the env variable to run the suite:
 *
 *                   LUNORA_WORKERD_TESTS=1 pnpm --filter @lunora/do test
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
                          name: "mocks",
                          environment: "node",
                          include: ["__tests__/*.test.ts"],
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
                          name: "workerd",
                          include: ["__tests__/workerd/**/*.test.ts"],
                      },
                  },
              ]
            : [
                  {
                      extends: true,
                      test: {
                          name: "mocks",
                          environment: "node",
                          include: ["__tests__/*.test.ts"],
                      },
                  },
              ],
    },
});
