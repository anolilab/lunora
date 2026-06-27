import { coverageConfigDefaults, defineConfig } from "vitest/config";

// The package's source is Node-safe (the only workerd-coupled file, `src/do`,
// imports `cloudflare:workers`, which is exercised by the build + type-check,
// not by these unit tests). So a plain Node test project is enough — no
// `@cloudflare/vitest-pool-workers` projects needed here.
const coverage = {
    ...coverageConfigDefaults,
    provider: "v8" as const,
    reporter: ["clover", "cobertura", "lcov", "text", "html"],
    include: ["src"],
    exclude: [
        ...(coverageConfigDefaults.exclude ?? []),
        "__fixtures__/**",
        "src/**/types.ts",
        // `src/do` imports `cloudflare:workers` (workerd-only) — verified by the
        // build + `tsc`, not reachable from Node unit tests.
        "src/do/**",
        "**/node_modules/**",
        "**/dist/**",
    ],
};

export default defineConfig({
    test: {
        coverage,
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
    },
});
