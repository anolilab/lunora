/// <reference types="vitest" />
import analog from "@analogjs/platform";
import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

// https://analogjs.org — AnalogJS is a Vite-first Angular meta-framework. The
// `@analogjs/platform` plugin owns Angular compilation, file-based routing, and
// the Nitro SSR server.
export default defineConfig(({ mode }) => ({
    build: {
        target: ["es2022"],
    },
    plugins: [
        analog({
            // Analog runs SSR through Nitro. The `cloudflare-module` preset emits
            // a Cloudflare module worker at `dist/analog/server/index.mjs`. The
            // project-root `exports.cloudflare.ts` re-exports `ShardDO` onto that
            // worker entry so the Durable Object class ships in the same single
            // deploy as the Analog SSR handler.
            nitro: {
                preset: "cloudflare-module",
            },
        }),
        // Lunora codegen — regenerates `lunora/_generated/` (api, server,
        // dataModel, app, shard, …) so the Angular page + the `/_lunora/**`
        // server route can import the typed API.
        //
        // `cloudflare: false` — Analog/Nitro owns the Cloudflare adapter via its
        //   own preset; we don't wire `@cloudflare/vite-plugin` through here.
        // `validateWrangler: false` — wrangler validation is deferred to deploy
        //   time (the single `wrangler.jsonc` points `main` at Nitro's output,
        //   which only exists after `vite build`).
        lunora({ cloudflare: false, validateWrangler: false }),
    ],
    // Avoid pre-bundling Angular packages that ship their own ESM.
    optimizeDeps: {
        include: ["@angular/common", "@angular/core"],
    },
    // Keep the Lunora vanilla client out of SSR externalization so it bundles
    // for the browser build.
    ssr: {
        noExternal: mode === "production" ? ["lunorash", "@angular/**"] : undefined,
    },
}));
