/**
 * The Lunora **Nuxt module** — single-worker composition, the inverse of the
 * old two-worker split. Instead of Lunora owning the Cloudflare worker entry, it
 * is mounted *inside* Nitro: a server route at `&lt;prefix>/**` (default
 * `/_lunora/**`) forwards every RPC / WebSocket / admin request to the project's
 * Lunora app (`createWorker(...)` / `defineApp().build()`), which runs in the
 * same worker Nuxt deploys as. The `ShardDO` Durable Object class is carried to
 * the generated worker entrypoint by the project's root `exports.cloudflare.ts`
 * (a documented Nitro `cloudflare_module` hook) — so one `wrangler.jsonc`, one
 * deploy, and a same-origin client.
 *
 * Add it in `nuxt.config.ts`:
 *
 * ```ts
 * export default defineNuxtConfig({
 *   modules: ["@lunora/nuxt"],
 *   nitro: { preset: "cloudflare_module" },
 * });
 * ```
 *
 * and add `exports.cloudflare.ts` to the project root:
 *
 * ```ts
 * export { ShardDO } from "./lunora/server";
 * ```
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { addServerHandler, createResolver, defineNuxtModule, useLogger } from "@nuxt/kit";

/** Options for the `@lunora/nuxt` module (configurable under the `lunora` key in `nuxt.config`). */
interface ModuleOptions {
    /**
     * Module specifier of the Lunora app entry — its default export is the built
     * worker (`defineApp().build()` / `createWorker(...)`) and it re-exports
     * `ShardDO`. Aliased to the `#lunora/app` virtual the server route imports.
     */
    appEntry: string;
    /** URL prefix Lunora realtime is mounted at. */
    prefix: string;
}

export default defineNuxtModule<ModuleOptions>({
    defaults: {
        appEntry: "~/lunora/server",
        prefix: "/_lunora",
    },
    meta: {
        configKey: "lunora",
        name: "@lunora/nuxt",
    },
    setup(options, nuxt) {
        const resolver = createResolver(import.meta.url);

        // Alias the `#lunora/app` virtual (imported by the Nitro server route) to
        // the project's Lunora app entry. Nuxt forwards `options.alias` into the
        // Nitro server bundle, so the server route resolves it there too.
        // eslint-disable-next-line no-param-reassign -- nuxt.options is the documented module-mutation surface
        nuxt.options.alias["#lunora/app"] = options.appEntry;

        // Mount Lunora realtime (RPC + WebSocket + admin) as a Nitro server route.
        // The handler reconstructs a Web Request, resolves the Cloudflare env/ctx
        // off the event, and forwards to the Lunora app's `fetch` in-process.
        addServerHandler({
            handler: resolver.resolve("./runtime/server/lunora"),
            route: `${options.prefix}/**`,
        });

        // The `ShardDO` class must reach the generated Cloudflare worker via a
        // root `exports.cloudflare.ts`. We can't write the user's file, so warn
        // when it's missing rather than fail an otherwise-valid build.
        if (!existsSync(join(nuxt.options.rootDir, "exports.cloudflare.ts"))) {
            useLogger("@lunora/nuxt").warn(
                'missing exports.cloudflare.ts at the project root — add `export { ShardDO } from "./lunora/server";` so the SHARD Durable Object is exported from the worker.',
            );
        }
    },
});
