import { coverageConfigDefaults, defineConfig } from "vitest/config";

// R2 SQL is a pure REST client + SQL builder, so the suite is plain-Node over an
// injected `fetch` double — no workerd pool, no network.
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
        include: ["__tests__/**/*.test.ts"],
    },
});
