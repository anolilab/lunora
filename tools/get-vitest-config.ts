/// <reference types="vitest" />
import type { ViteUserConfig } from "vitest/config";
import { defineConfig, configDefaults, coverageConfigDefaults } from "vitest/config";

const VITEST_SEQUENCE_SEED = Date.now();

export interface CoverageThresholds {
    branches?: number;
    functions?: number;
    lines?: number;
    statements?: number;
}

/**
 * Default coverage floor for every package on the shared config. Packages that
 * sit below it get an explicit lower override at their call site (with a
 * `// ratchet:` comment) and raise it over time instead of blocking.
 *
 * Thresholds only apply when coverage is enabled (`vitest run --coverage`, the
 * `test:coverage` scripts); plain `vitest run` is unaffected. The workerd-gated
 * packages (client, d1, do, runtime, scheduler, storage) use inline
 * `defineConfig` configs — not this helper — and stay threshold-free: their
 * workerd projects run without coverage (v8/`node:inspector` is unsupported in
 * `@cloudflare/vitest-pool-workers`), so a floor there would gate on a
 * structurally incomplete number.
 */
export const DEFAULT_COVERAGE_THRESHOLDS: Required<CoverageThresholds> = {
    branches: 70,
    functions: 80,
    lines: 80,
    statements: 80,
};

// https://vitejs.dev/config/
export const getVitestConfig = (options: ViteUserConfig = {}, coverageThresholds: CoverageThresholds = {}) => {
    console.log("VITEST_SEQUENCE_SEED", VITEST_SEQUENCE_SEED);

    return defineConfig({
        ...options,
        test: {
            ...configDefaults,
            coverage: {
                ...coverageConfigDefaults,
                provider: "v8",
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
                thresholds: {
                    ...DEFAULT_COVERAGE_THRESHOLDS,
                    ...coverageThresholds,
                },
            },
            environment: "node",
            hideSkippedTests: true,
            // vis runs coverage for many projects concurrently; under that CI
            // contention (v8 instrumentation + oversubscribed cores) individual
            // tests that finish in <1s locally can blow past the 5s default and
            // fail spuriously. Give them generous headroom in CI.
            testTimeout: process.env.CI ? 30_000 : 10_000,
            hookTimeout: process.env.CI ? 30_000 : 10_000,
            reporters: process.env.CI
                ? process.env.CI_PREFLIGHT
                    ? ["dot", "github-actions"]
                    : ["dot"]
                : ["default"],
            sequence: {
                seed: VITEST_SEQUENCE_SEED,
            },
            silent: process.env.CI ? "passed-only" : false,
            typecheck: {
                enabled: false,
            },
            ...options.test,
            exclude: [...configDefaults.exclude, "__fixtures__/**", ...(options.test?.exclude ?? [])],
        },
    });
};
