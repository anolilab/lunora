import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Plain-Node unit suite over the x402 protocol glue (charge middleware + pay
// wallet/policy) against in-memory facilitator/account doubles — no real chain,
// no network. A workerd smoke that boots `@x402/core` + `@x402/evm` in the pool
// lives behind `LUNORA_WORKERD_TESTS=1` (added in Phase 1); it is not spun up
// here because the pool is environment-dependent in this sandbox.
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

export default defineConfig({
    test: {
        coverage,
        environment: "node",
        include: ["src/**/*.test.ts", "__tests__/**/*.test.ts"],
    },
});
