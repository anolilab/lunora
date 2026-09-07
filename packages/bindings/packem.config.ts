import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // This package is deliberately subpath-only: each binding (`./kv`, `./images`,
    // `./vectors`, …) is its own entry and there is no `src/index.ts`. packem's
    // exports check wants a `.` export; adding a barrel purely to satisfy it would
    // invent a public entry nothing imports and let a consumer pull all six
    // bindings in one specifier — the opposite of why they are split.
    validation: {
        packageJson: {
            exports: false,
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
