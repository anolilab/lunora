/// <reference types="vitest" />
import type { ViteUserConfig } from "vitest/config";
import { defineConfig, configDefaults, coverageConfigDefaults } from "vitest/config";

const VITEST_SEQUENCE_SEED = Date.now();

// https://vitejs.dev/config/
export const getVitestConfig = (options: ViteUserConfig = {}) => {
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
