/**
 * The Lunora **Nuxt module** — single-worker composition, the inverse of the
 * old two-worker split. Instead of Lunora owning the Cloudflare worker entry, it
 * is mounted *inside* Nitro: a server route at `&lt;prefix>/**` (default
 * `/_lunora/**`) forwards every RPC / WebSocket / admin request to the project's
 * Lunora app (`createWorker(...)` / `defineApp().build()`), which runs in the
 * same worker Nuxt deploys as. The `ShardDO` Durable Object class is carried to
 * the deployed worker by a root `worker.ts` wrapper (`wrangler.jsonc`'s `main`)
 * that re-exports Nitro's SSR handler plus `ShardDO` — so one `wrangler.jsonc`,
 * one deploy, and a same-origin client. (Nitro's `cloudflare_module` output
 * exports only the SSR handler, so `main` must point at the wrapper, not the raw
 * `.output/server/index.mjs`, or `wrangler deploy` fails on the missing DO.)
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
 * and add a `worker.ts` wrapper at the project root, pointed at by
 * `wrangler.jsonc`'s `main`:
 *
 * ```ts
 * export { default } from "./.output/server/index.mjs";
 * export { ShardDO } from "./lunora/server";
 * ```
 */

/* eslint-disable import/exports-last -- the public ModuleOptions type is declared next to the module definition it configures rather than grouped at the file end */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { addServerHandler, createResolver, defineNuxtModule, useLogger } from "@nuxt/kit";

import resolveTildePath from "./resolve-tilde-path";

/** Matches a trailing `.js` extension so it can be swapped for `.ts` (module-scope: compiled once). */
const JS_EXTENSION_SUFFIX = /\.js$/;

/**
 * Minimal structural shape of the rollup plugin this module contributes (a
 * `name` + an object-form `resolveId` hook). Declared locally because `rollup`
 * is not a direct dependency — it's the Nitro server bundler, resolved at the
 * consumer's build time — and this object is a valid rollup plugin at runtime.
 */
interface TsSourceResolverPlugin {
    name: string;
    resolveId: {
        handler: (source: string, importer: string | undefined) => string | undefined;
        order: "pre";
    };
}

/** Minimal shape of the `nitro:config` hook payload this module mutates (Nitro's `NitroConfig` isn't in the installed Nuxt Kit typed hook map). */
interface NitroConfigLike {
    rollupConfig?: { plugins?: unknown[] };
}

/**
 * Rollup plugin (injected into the Nitro server build) that rewrites codegen's
 * NodeNext `.js`-extension imports to their real `.ts` source. `@lunora/codegen`
 * deliberately emits `.js` specifiers (mandatory under NodeNext), and Vite/esbuild
 * resolve those to the `.ts` files — but Nitro's server rollup does NOT, so the
 * Lunora app entry chain (`lunora/server.ts` to `_generated/app.ts`) fails to
 * bundle with "Cannot resolve ... and externals are not allowed". This resolves
 * `#lunora/*` (mapped to `rootDir/lunora/*` by the project package.json
 * `imports`) and relative `.js` imports to a sibling `.ts` when one exists — a
 * strict no-op for every other `.js` (only rewrites when the `.ts` is present).
 */
const lunoraTsSourceResolver = (rootDirectory: string): TsSourceResolverPlugin => {
    const lunoraDirectory = join(rootDirectory, "lunora");

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
                    absolute = resolve(dirname(importer), source);
                }

                if (absolute === undefined) {
                    return undefined;
                }

                const tsSource = absolute.replace(JS_EXTENSION_SUFFIX, ".ts");

                return existsSync(tsSource) ? tsSource : undefined;
            },
            order: "pre",
        },
    };
};

/** Options for the `@lunora/nuxt` module (configurable under the `lunora` key in `nuxt.config`). */
export interface ModuleOptions {
    /**
     * Module specifier of the Lunora app entry — its default export is the built
     * worker (`defineApp().build()` / `createWorker(...)`) and it re-exports
     * `ShardDO`. Aliased to the `#lunora/app` virtual the server route imports.
     */
    appEntry: string;
    /** URL prefix Lunora realtime is mounted at. */
    prefix: string;
}

/**
 * Return type of `defineNuxtModule&lt;ModuleOptions>({...})` — the value overload of
 * `defineNuxtModule` (the one taking a definition), extracted structurally so the
 * default export has a locally-nameable type under `isolatedDeclarations` without
 * importing `NuxtModule` from `@nuxt/schema` (not a resolvable dependency here).
 */
type LunoraNuxtModule = typeof defineNuxtModule<ModuleOptions> extends {
    (definition: infer _Definition): infer Result;
    (): unknown;
}
    ? Result
    : never;

const lunoraNuxtModule: LunoraNuxtModule = defineNuxtModule<ModuleOptions>({
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
        // the project's Lunora app entry, resolved to an ABSOLUTE path first (see
        // resolveTildePath — a `~` tilde would be re-resolved against Nitro's own
        // `server/` dir and break the server build). Nuxt forwards `options.alias`
        // into the Nitro server bundle, so the server route resolves it there too.
        // eslint-disable-next-line no-param-reassign -- nuxt.options is the documented module-mutation surface
        nuxt.options.alias["#lunora/app"] = resolveTildePath(options.appEntry, nuxt.options.rootDir, nuxt.options.srcDir);

        // Teach the Nitro server bundle to resolve codegen's `.js` imports to
        // their `.ts` source (rollup, unlike Vite/esbuild, won't). Without this
        // the aliased app entry chain (`lunora/server.ts` → `_generated/*`) fails
        // to bundle. Injected via `nitro:config` so it rides on the server build.
        // That hook + `NitroConfig` aren't in this @nuxt/kit version's typed maps,
        // so cast the hook name + config to the minimal shape this touches.
        (nuxt as unknown as { hook: (name: "nitro:config", callback: (config: NitroConfigLike) => void) => void }).hook("nitro:config", (nitroConfig) => {
            const plugins = [...(nitroConfig.rollupConfig?.plugins ?? []), lunoraTsSourceResolver(nuxt.options.rootDir)];

            // eslint-disable-next-line no-param-reassign -- the nitro:config hook exists to mutate the passed config
            nitroConfig.rollupConfig = { ...nitroConfig.rollupConfig, plugins };
        });

        // Mount Lunora realtime (RPC + WebSocket + admin) as a Nitro server route.
        // The handler reconstructs a Web Request, resolves the Cloudflare env/ctx
        // off the event, and forwards to the Lunora app's `fetch` in-process.
        addServerHandler({
            handler: resolver.resolve("./runtime/server/lunora"),
            route: `${options.prefix}/**`,
        });

        // The `ShardDO` class must reach the deployed Cloudflare worker: Nitro's
        // `cloudflare_module` output exports only the SSR handler, so the project
        // needs a root `worker.ts` wrapper (pointed at by `wrangler.jsonc`'s
        // `main`) that re-exports `ShardDO` too. We can't write the user's file,
        // so warn when it's missing rather than fail an otherwise-valid build.
        if (!existsSync(join(nuxt.options.rootDir, "worker.ts"))) {
            useLogger("@lunora/nuxt").warn(
                'missing worker.ts at the project root — add a wrapper that re-exports Nitro\'s handler and `ShardDO` (`export { default } from "./.output/server/index.mjs"; export { ShardDO } from "./lunora/server";`) and point wrangler\'s `main` at it, so the SHARD Durable Object is exported from the deployed worker.',
            );
        }
    },
});

export default lunoraNuxtModule;
