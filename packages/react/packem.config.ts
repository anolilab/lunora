import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createReactPreset } from "@visulima/packem/config/preset/react";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    externals: [/^react($|\/)/, /^react-dom($|\/)/],
    // Run React Compiler over the hooks/provider so manual `useMemo`/`useCallback`
    // can be dropped from source — the compiler emits optimal memoization at
    // build time. Babel (preset-react + the compiler) runs ahead of esbuild.
    // `panicThreshold: "none"` lets the compiler silently bail on a component it
    // can't yet optimize instead of failing the build (incremental adoption).
    preset: createReactPreset({ plugins: [["babel-plugin-react-compiler", { panicThreshold: "none" }]] }),
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
