import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createReactPreset } from "@visulima/packem/config/preset/react";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    externals: [/^react($|\/)/, /^react-dom($|\/)/],
    // Run React Compiler over the studio components so the compiler emits optimal
    // memoization at build time and manual `useMemo`/`useCallback`/`memo` can be
    // dropped from source. Babel (preset-react + the compiler) runs ahead of
    // esbuild. `panicThreshold: "none"` lets the compiler silently bail on a
    // component it can't yet optimize instead of failing the build — required for
    // incremental adoption over an existing codebase with compiler-bailout sites
    // (try/finally bodies, ref-in-render, set-state-in-effect, …).
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
