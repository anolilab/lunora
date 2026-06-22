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
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
    cjsInterop: true,
    validation: {
        dependencies: {
            unused: {
                exclude: ["@bomb.sh/tab", "cfonts", "react-reconciler"],
            },
            hoisted: {
                exclude: ["@visulima/interactive-manager", "@visulima/is-ansi-color-supported"],
            },
        },
    },
}) as BuildConfig;
