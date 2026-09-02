import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        // The runCodegen smoke test parses the schema + functions with ts-morph,
        // which can take >5s under CI contention; give it headroom so it doesn't
        // trip Vitest's 5s default. (Inlined rather than importing the shared
        // tools/get-vitest-config because the app tsconfig's rootDir forbids it.)
        //
        // UNCONDITIONAL, not `process.env.CI ? 30_000 : 10_000`. That ternary is
        // why this suite was believed to hang: a cold `runCodegen` takes ~15s
        // locally, blew the 10s local budget, and the timeout was read as a hang
        // and the whole project excluded from the root test query. It is a slow
        // test, not a hanging one — one budget, so a local run and a CI run agree.
        hookTimeout: 30_000,
        testTimeout: 30_000,
    },
});
