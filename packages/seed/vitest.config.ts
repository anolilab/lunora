import { coverageConfigDefaults, defineConfig } from "vitest/config";

// @lunora/seed is a build-time / test-time tool (schema introspection + a
// deterministic faker-backed generator), so the suite is plain-Node — no
// workerd pool needed. The testing-adapter test drives @lunora/testing's
// in-memory `node:sqlite` harness, which is also plain Node.
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
