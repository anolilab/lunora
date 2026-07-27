import type { BuildConfig } from "@visulima/packem/config";
import { defineConfig } from "@visulima/packem/config";
import transformer from "@visulima/packem/transformer/esbuild";

// eslint-disable-next-line import/no-unused-modules -- consumed by packem CLI
export default defineConfig({
    /**
     * Keep the optional peer out of the bundled types.
     *
     * `src/paid.ts` imports types from `@lunora/x402/charge`. Since x402 became
     * an OPTIONAL peer it is no longer in the dependency closure a consumer
     * builds — `pnpm --filter @lunora/docs... run build`, which is what Netlify
     * runs, never builds it — so the dts bundler tried to inline a `dist/` that
     * does not exist yet and failed the whole site build. Declaring it external
     * emits a type *reference* instead, which is what a peer dependency should
     * produce anyway.
     */
    externals: [/^@lunora\/x402($|\/)/],
    runtime: "node",
    rollup: {
        dts: {
            oxc: true,
        },
        license: {
            path: "./LICENSE.md",
        },
    },
    transformer,
    failOnWarn: false,
}) as BuildConfig;
