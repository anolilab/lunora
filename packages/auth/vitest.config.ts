import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { coverageConfigDefaults, defineConfig } from "vitest/config";

import { DEFAULT_COVERAGE_THRESHOLDS } from "../../tools/get-vitest-config";

// Mirror of the shared `tools/get-vitest-config` coverage block. The workers pool
// relies on `defineConfig` (not the shared helper, which would break the
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
        "e2e",
        "**/node_modules/**",
        "**/dist/**",
    ],
    // Imported, not copied. Moving this package off `getVitestConfig` for the workers
    // pool otherwise drops its coverage floor silently — which is a poor trade on an
    // auth package. The default run here is node-only (workerd is opt-in), so unlike
    // the always-workerd packages the number is complete and the floor is meaningful.
    thresholds: { ...DEFAULT_COVERAGE_THRESHOLDS },
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the rationale
 * behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `node`    — the unit suites over the better-auth wrapper (adapter, audit,
 *                email guard, plugin surface). Always on.
 *  - `workerd` — real workerd via `@cloudflare/vitest-pool-workers`, proving the
 *                enterprise-auth plugins load in the runtime they ship to:
 *                `@better-auth/sso` statically imports `samlify` +
 *                `node:crypto`'s `X509Certificate`, so a Node-only pass says
 *                nothing about whether an app can actually deploy it.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

// Mirrors `tools/get-vitest-config`: CI runs coverage-instrumented and contended, so
// the 5s default times out spuriously; the seed keeps order-dependence from hiding.
const CI_TIMEOUTS = {
    hookTimeout: process.env["CI"] ? 30_000 : 10_000,
    testTimeout: process.env["CI"] ? 30_000 : 10_000,
};

const nodeProject = {
    extends: true,
    test: {
        ...CI_TIMEOUTS,
        environment: "node",
        // `__tests__/**` rather than `__tests__/*`, minus the workerd project's own
        // directory — a nested suite under the single-level glob would silently not run.
        exclude: ["__tests__/workerd/**"],
        include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
        name: "node",
        sequence: { seed: 1 },
    },
};

export default defineConfig({
    test: {
        coverage,
        projects: runWorkerd
            ? [
                  nodeProject,
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { ...CI_TIMEOUTS, include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ]
            : [nodeProject],
    },
});
