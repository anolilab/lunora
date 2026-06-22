import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    failOnWarn: false,
    rollup: {
        // tsc-based dts (not oxc isolated-declarations): the Nuxt module's default
        // export is `defineNuxtModule(...)`, whose inferred `NuxtModule<…>` type is
        // too complex for isolated declarations to emit without an explicit annotation.
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
}) as BuildConfig;
