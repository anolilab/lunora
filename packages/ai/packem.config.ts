import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    // `@ai-sdk/openai` / `@ai-sdk/anthropic` are imported by `workers-ai-provider`'s
    // `/openai` and `/anthropic` gateway plugins (optional peers there), not by
    // `src/` directly — so packem sees them as unused. They must stay in
    // `dependencies` so the peers resolve for every app that installs `@lunora/ai`:
    // without them, `ctx.ai.model("anthropic/…")` fails at import time.
    validation: {
        dependencies: {
            unused: { exclude: ["@ai-sdk/anthropic", "@ai-sdk/openai"] },
        },
    },
    rollup: {
        dts: {
            oxc: true,
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
}) as BuildConfig;
