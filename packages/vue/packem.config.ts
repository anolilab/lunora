import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "browser",
    failOnWarn: false,
    // Vue is a peer dependency — never bundle it; the host app supplies the
    // single Vue instance so `inject`/`provide` and reactivity share identity.
    externals: [/^vue($|\/)/, /^@vue\//],
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
