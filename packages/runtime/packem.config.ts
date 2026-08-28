import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // Reached only through the declared `@lunora/workflow` peer, which lists it in
    // its OWN `dependencies` — the declaration build follows workflow's types to
    // get there. Nothing in `src` imports it (see the note in describe-args.ts)
    // and `dist/index.mjs` carries no reference, so declaring it here would invent
    // a dependency the published package does not have.
    validation: {
        dependencies: {
            hoisted: { exclude: ["@lunora/values"] },
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
