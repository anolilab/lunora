import { defineConfig, coverageConfigDefaults } from "vitest/config";

// Plain-Node Vitest. The Images surface is exercised with in-memory binding
// doubles (the `ImagesBindingLike` chain is structural) and the URL/signed-URL
// helpers run directly on WebCrypto — no workerd pool needed for the unit suite.
// Anything requiring the real `env.IMAGES` worker pool is gated `skipIf(!CI)`
// inside the test, since workerd can't run in the local sandbox.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [...(coverageConfigDefaults.exclude ?? []), "__fixtures__/**", "src/**/types.ts", "e2e", "**/node_modules/**", "**/dist/**"],
};

export default defineConfig({
    test: {
        coverage,
        environment: "node",
        include: ["src/**/__tests__/**/*.test.ts"],
    },
});
