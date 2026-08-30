import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // Reached only through the declared `@lunora/server` peer, which lists all
    // three in its OWN `dependencies` — so anyone who can install this package
    // already has them, and re-declaring them here would duplicate the peer's
    // version choice. They surface as "hoisted" because the declaration build
    // follows `@lunora/server`'s types, not because our output imports them
    // (`dist` imports exactly `@lunora/errors` and `jose`).
    validation: {
        dependencies: {
            hoisted: { exclude: ["@lunora/scheduler", "@lunora/values", "hono"] },
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
