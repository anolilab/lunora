import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// Client adapter: builds for the browser and externalises `@angular/core` (a peer
// dependency — the host app supplies the single Angular runtime so signals /
// injectors share identity) and `@lunora/client`. No Angular decorators are used
// in this package, so plain esbuild suffices (no Angular compiler needed).
// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
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
