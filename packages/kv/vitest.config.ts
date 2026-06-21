import { coverageConfigDefaults, defineConfig } from "vitest/config";

// Coverage block mirrors the shared `tools/get-vitest-config` defaults. KV is a
// pure facade over the binding, so the test suite is plain-Node over an
// in-memory `Map`-backed `KVNamespaceLike` fake — no workerd pool needed.
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
