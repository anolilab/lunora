import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createSolidPreset } from "@visulima/packem/config/preset/solid";
import transformer from "@visulima/packem/transformer/esbuild";

// The Solid preset wires `babel-preset-solid` to compile the adapter's JSX
// (`lunora-provider.tsx`) ahead of esbuild, externalises `solid-js` (a peer
// dependency — the host app must supply the single Solid runtime so signals
// share identity), and resolves the `solid` export condition. Without it the
// raw JSX can't be parsed once the library splits into multiple entry chunks.
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    preset: createSolidPreset(),
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
