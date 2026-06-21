import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        // The runCodegen smoke test parses the schema + functions with ts-morph,
        // which can take >5s under CI contention; give it headroom so it doesn't
        // trip Vitest's 5s default. (Inlined rather than importing the shared
        // tools/get-vitest-config because the app tsconfig's rootDir forbids it.)
        hookTimeout: process.env.CI ? 30_000 : 10_000,
        testTimeout: process.env.CI ? 30_000 : 10_000,
    },
});
