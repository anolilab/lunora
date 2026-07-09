import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    // React, React Native, TanStack Query, and the better-auth Expo stack are
    // peers/optional-peers — never bundle them. `@lunora/*` deps are external by
    // virtue of being declared dependencies.
    externals: [/^react($|\/)/, /^react-dom($|\/)/, /^react-native($|\/)/, /^@tanstack\//, /^better-auth($|\/)/, /^@better-auth\//, /^expo-/],
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
