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
};

/**
 * Two-project Vitest config (see `packages/do/vitest.config.ts` for the
 * rationale behind the `LUNORA_WORKERD_TESTS=1` opt-in gate):
 *
 *  - `mocks`   — Node unit suite over the x402 protocol glue (charge middleware
 *                + pay wallet/policy) against in-memory facilitator/account
 *                doubles — no real chain, no network. Always on.
 *  - `workerd` — real workerd via `@cloudflare/vitest-pool-workers`: boots
 *                `@x402/core` +
 *                `@x402/evm` in the pool and drives the `withX402` charge
 *                middleware + the `.x402({ price })` procedure seam to a real
 *                402 challenge, with the facilitator mocked at the fetch
 *                boundary (see `__tests__/workerd/`).
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

export default defineConfig({
    test: {
        coverage,
        projects: runWorkerd
            ? [
                  {
                      extends: true,
                      test: { name: "mocks", environment: "node", include: ["src/**/*.test.ts", "__tests__/*.test.ts"] },
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
                      test: { name: "mocks", environment: "node", include: ["src/**/*.test.ts", "__tests__/*.test.ts"] },
                  },
              ],
    },
});
