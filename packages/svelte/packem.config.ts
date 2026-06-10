import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createSveltePreset } from "@visulima/packem/config/preset/svelte";
import transformer from "@visulima/packem/transformer/esbuild";

// A browser-targeted client adapter. Uses packem's Svelte preset for parity with
// the other framework adapters (it resolves the `svelte` export condition + a
// browser target; the `.svelte` compiler it wires is inert here since the adapter
// is pure stores in `.ts`, but it future-proofs adding a component). `svelte`/
// `svelte/store` are peer deps and stay external — the host app supplies the one
// Svelte runtime so store/context identity is shared.
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    externals: [/^svelte($|\/)/],
    preset: createSveltePreset(),
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
