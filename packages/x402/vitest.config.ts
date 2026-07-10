import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Plain-Node unit suite over the x402 protocol glue (charge middleware + pay
// wallet/policy) against in-memory facilitator/account doubles — no real chain,
// no network. A workerd smoke that boots `@x402/core` + `@x402/evm` in the pool
// (Phase 1 item 5) is still deferred: the `@cloudflare/vitest-pool-workers` pool
// needs unrestricted localhost-loopback and does not boot in this sandbox (it
// hangs on connect-timeout). When a booting workerd is available, add it as a
// second `LUNORA_WORKERD_TESTS=1`-gated project mirroring @lunora/storage's
// two-project config (`__tests__/workerd/**` + a `wrangler.jsonc`).
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
