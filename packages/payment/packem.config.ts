import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    failOnWarn: false,
    externals: [/^@lunora\//, /^dinero\.js($|\/)/, /^stripe($|\/)/, /^@polar-sh\/sdk($|\/)/, /^autumn-js($|\/)/, /^dodopayments($|\/)/, /^creem($|\/)/],
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
