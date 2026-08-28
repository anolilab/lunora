import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // Reached only through the declared `@lunora/server` peer, which lists all four
    // in its OWN `dependencies`. Nothing in this package's `dist` imports them —
    // neither the bundle nor the declarations — so they surface only because the
    // declaration build follows the peer's types.
    validation: {
        dependencies: {
            hoisted: { exclude: ["@lunora/errors", "@lunora/scheduler", "@lunora/values", "hono"] },
            unused: { exclude: [] },
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
