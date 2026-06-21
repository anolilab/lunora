import { defineConfig, coverageConfigDefaults } from "vitest/config";

// Plain-Node unit suite over a fake `@cloudflare/playwright` double. There is no
// workerd project here: the whole surface is a thin wrapper over
// `launch(env.BROWSER)`, which can't run in this sandbox (workerd +
// the Browser Rendering binding require Cloudflare's edge), so any test that
// needs a real `env.BROWSER` is gated CI-only inside the suite via
// `describe.skipIf(!process.env.CI)` rather than spun up here.
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
