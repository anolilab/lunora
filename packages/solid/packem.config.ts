import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import { createSolidPreset } from "@visulima/packem/config/preset/solid";
import transformer from "@visulima/packem/transformer/esbuild";

// The Solid preset externalises `solid-js` (a peer dependency — the host app
// must supply the single Solid runtime so signals share identity) and resolves
// the `solid` export condition.
//
// Its third job, compiling JSX through `babel-preset-solid`, is now a no-op:
// this package has no `.tsx` source. That is deliberate. Solid 1.x and 2.0
// compile JSX against different runtimes (`solid-js/web` vs `@solidjs/web`), so
// a JSX source file would force two builds; the components are written with
// `createComponent` instead, which both majors export from the package root.
// See src/solid-compat.ts. Keep the preset regardless — the externalisation is
// what stops a second Solid copy being bundled into `dist/`.
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
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
