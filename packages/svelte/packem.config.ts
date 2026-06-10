import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// A browser-targeted client adapter (live stores over `@cirrus/client`), matching
// `@cirrus/solid`/`@cirrus/vue`. `svelte`/`svelte/store` are peer deps and stay
// external — the host app supplies the single Svelte runtime.
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    externals: [/^svelte($|\/)/],
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
