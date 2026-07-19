import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({
    test: {
        environment: "node",
        // The agent/schema discovery specs each spin up several ts-morph
        // Projects that resolve real `@lunora/*` type files — the heaviest work
        // in the suite. Locally the whole file finishes in ~9s, but under CI's
        // oversubscribed cores a single spec can slow ~3x and blow the shared
        // 30s ceiling. Give this suite double the base headroom.
        hookTimeout: process.env.CI ? 60_000 : 10_000,
        testTimeout: process.env.CI ? 60_000 : 10_000,
    },
});
