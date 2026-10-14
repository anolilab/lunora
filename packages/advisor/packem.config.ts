import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    runtime: "node",
    // `@lunora/errors` is imported as a value by `src/ae-metrics.ts`, so it has to
    // stay in `dependencies` (import/no-extraneous-dependencies enforces that for
    // anything under `src/`). packem cannot see it because that module's value
    // exports are quarantined — `src/index.ts` re-exports only its types, so the
    // code that throws is tree-shaken out and never reaches `dist`. Un-quarantine
    // those exports and the dependency becomes live again; drop this exclusion then.
    validation: {
        dependencies: {
            hoisted: { exclude: [] },
            unused: { exclude: ["@lunora/errors"] },
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
