import { existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import analog from "@analogjs/platform";
import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

const ROOT_DIR = dirname(fileURLToPath(import.meta.url));

/** Matches a trailing `.js` extension so it can be swapped for `.ts`. */
const JS_EXTENSION_SUFFIX = /\.js$/;

/**
 * Rollup plugin for the Nitro server build that rewrites codegen's NodeNext
 * `.js`-extension imports to their real `.ts` source.
 *
 * `@lunora/codegen` deliberately emits `.js` specifiers — mandatory under
 * NodeNext, which is how `_generated/*` is consumed — and Vite/esbuild resolve
 * those to the `.ts` files. Nitro's server rollup does not, so the app entry
 * chain (`lunora/server.ts` → `#lunora/_generated/app.js`) fails to bundle with
 * `Could not load .../lunora/_generated/app.js: ENOENT`.
 *
 * A strict no-op for every other `.js`: it only rewrites when the sibling `.ts`
 * actually exists. Mirrors the plugin `@lunora/nuxt` injects for the same reason
 * (`packages/nuxt/src/module.ts`) — keep the two in step.
 */
const lunoraTsSourceResolver = () => {
    const lunoraDirectory = join(ROOT_DIR, "lunora");

    return {
        name: "lunora:nitro-ts-source-resolve",
        resolveId: {
            handler(source: string, importer: string | undefined): string | undefined {
                if (!source.endsWith(".js")) {
                    return undefined;
                }

                let absolute: string | undefined;

                if (source.startsWith("#lunora/")) {
                    absolute = join(lunoraDirectory, source.slice("#lunora/".length));
                } else if (source.startsWith(".") && importer !== undefined) {
                    absolute = resolvePath(dirname(importer), source);
                }

                if (absolute === undefined) {
                    return undefined;
                }

                const tsSource = absolute.replace(JS_EXTENSION_SUFFIX, ".ts");

                return existsSync(tsSource) ? tsSource : undefined;
            },
            order: "pre" as const,
        },
    };
};

// https://analogjs.org — AnalogJS is a Vite-first Angular meta-framework. The
// `@analogjs/platform` plugin owns Angular compilation, file-based routing, and
// the Nitro SSR server.
export default defineConfig(({ mode }) => ({
    // Analog resolves `index.html`, `src/main.ts` and `src/main.server.ts`
    // relative to the Vite root, so pin it to this file's directory rather than
    // to wherever the build happened to be invoked from.
    root: ROOT_DIR,
    build: {
        target: ["es2022"],
    },
    plugins: [
        analog({
            // NOTE: no `tsconfig` option, on purpose. Pointing the Angular
            // compiler at the root `tsconfig.json` silently produced EMPTY
            // bundles: that config sets `noEmit: true` (it is the editor /
            // `tsc --noEmit` config), so the compiler type-checked and emitted
            // nothing. The build then "succeeded" with a 0-byte
            // `dist/ssr/main.server.js` and only fell over later in Nitro, with
            // `does not provide an export named 'default'`. Left unset, the
            // plugin uses the conventional `tsconfig.app.json`, which turns
            // `noEmit` back off.
            nitro: {
                // Analog runs SSR through Nitro. The `cloudflare-module` preset
                // emits a Cloudflare module worker at
                // `dist/analog/server/index.mjs` that exports ONLY the SSR
                // handler as `default`. The project-root `worker.ts` re-exports
                // it plus `ShardDO` and is what `wrangler.jsonc`'s `main` points
                // at, so the Durable Object class ships in the same single
                // deploy as the Analog SSR handler.
                preset: "cloudflare-module",
                // Nitro's rollup cannot resolve codegen's `.js` specifiers on
                // its own — see `lunoraTsSourceResolver` above.
                rollupConfig: {
                    plugins: [lunoraTsSourceResolver()],
                },
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
