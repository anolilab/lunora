import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createVuePreset } from "@visulima/packem/config/preset/vue";
import transformer from "@visulima/packem/transformer/esbuild";

// A browser-targeted client adapter. Uses packem's Vue preset for parity with the
// other framework adapters (the `.vue` SFC compiler it wires is inert here since
// the adapter is pure composables in `.ts`, but it future-proofs adding an SFC).
// Vue is a peer dependency — never bundle it; the host app supplies the single Vue
// instance so `inject`/`provide` and reactivity share identity.
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    externals: [/^vue($|\/)/, /^@vue\//],
    preset: createVuePreset(),
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
