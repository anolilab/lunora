import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    // `@ai-sdk/anthropic` is imported by `workers-ai-provider`'s `/anthropic`
    // gateway plugin (an optional peer there), not by `src/` directly — so packem
    // sees it as unused. It must stay in `dependencies` so the peer resolves for
    // every app that installs `@lunora/ai`: without it, `ctx.ai.model("anthropic/…")`
    // fails at import time.
    validation: {
        dependencies: {
            unused: { exclude: ["@ai-sdk/anthropic"] },
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
