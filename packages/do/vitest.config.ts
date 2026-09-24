import { defineConfig, coverageConfigDefaults } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

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
    ],
    // RATCHET floor, pinned ~2pp under the measurement against the `mocks`
    // project alone (84.1 stmts / 73.5 branches / 77.1 funcs / 84.4 lines on
    // both the Node 22 and Node 24 legs) — the workerd project is intentionally
    // uncovered (v8 coverage cannot see into workerd; see the file-level
    // comment). Raise when tests land, never lower.
    //
    // Note for local runs: `LUNORA_WORKERD_TESTS=1` adds the workerd project to
    // this same config, and these thresholds then apply to a run whose second
    // project contributes tests but no v8 coverage. CI never hits that — its
    // coverage leg runs with the gate off — so a local threshold failure under
    // the gate is the gate, not a regression.
    thresholds: {
        branches: 71,
        functions: 75,
        lines: 82,
        statements: 82,
    },
};

/**
 * Two-project Vitest config:
 *
 *  - `mocks`   — legacy mock-state suite. Runs in plain Node, no Miniflare.
 *               Always enabled.
 *  - `workerd` — real workerd + Miniflare suite via `@cloudflare/vitest-plugin`.
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
        // Mirror tools/get-vitest-config: under contention some suites (e.g.
        // the distinct-path flood) exceed Vitest's 5s default. Projects inherit
        // this via `extends: true`.
        //
        // Flat, not keyed on `process.env.CI` — see that file for why. `vis`
        // fans the whole suite across a developer's machine while CI gets a
        // dedicated runner, so local is the MORE contended environment and a
        // CI-keyed ternary gives it the shorter fuse.
        testTimeout: 30_000,
        hookTimeout: 30_000,
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
