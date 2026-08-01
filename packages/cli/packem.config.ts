import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    rollup: {
        dts: {
            oxc: true,
        },
        // `commands/eval/handler.ts` does a genuinely dynamic `import()` of an
        // arbitrary, runtime-discovered `*.eval.ts` file (never a glob
        // candidate — the path is a `file://` URL built from a directory walk).
        // `@rollup/plugin-dynamic-import-vars` otherwise tries to turn every
        // non-literal `import()` argument into a glob and hard-fails when it
        // can't statically resolve one; excluding the one file that needs a
        // real runtime import keeps the plugin doing its normal job everywhere
        // else in the CLI.
        dynamicVars: {
            exclude: ["**/commands/eval/handler.ts"],
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
    cjsInterop: true,
    validation: {
        dependencies: {
            unused: {
                // `@lunora/testing` is a type-only import (`EvalResult`, in
                // `commands/eval/`) — the `eval` command never calls `evaluate`
                // itself, only a discovered project's own `*.eval.ts` file does
                // (from ITS OWN `@lunora/testing`), so packem's runtime-usage scan
                // sees no `import ... from` and flags it as unused.
                exclude: ["@bomb.sh/tab", "@lunora/testing", "cfonts", "react-reconciler"],
            },
            hoisted: {
                exclude: ["@visulima/interactive-manager", "@visulima/is-ansi-color-supported"],
            },
        },
    },
}) as BuildConfig;
