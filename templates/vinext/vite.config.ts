import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

/**
 * Tells the SSR render which origin to call Lunora on, during `vinext dev`.
 *
 * The browser can use `location.origin`; a server render has no page to be
 * relative to, so it needs an absolute URL. There is no second worker here —
 * `virtual:lunora/worker` composes Lunora and vinext's SSR handler into one
 * worker, so that origin is this very dev server. Hardcoding a port breaks the
 * moment it runs on another one (`vinext dev --port 3001`, a second app on the
 * same machine); reading the *resolved* port covers all of those.
 *
 * Two vinext-specific details, both load-bearing:
 *  - The port is read in `configResolved`, not `config`. vinext's CLI passes
 *    `--port` as inline config to `createServer`, so `config`'s `userConfig`
 *    reports `server.port` as undefined and a `config`-hook version of this
 *    plugin would silently inject the wrong port.
 *  - It runs on `serve` ONLY. A build must never bake a localhost origin into
 *    the deployed bundle — set `VITE_LUNORA_URL` to point a build at a
 *    standalone Worker; otherwise the browser falls back to its page origin,
 *    which is correct for this single-worker topology.
 */
const ssrOrigin = (): Plugin => {
    return {
        apply: "serve",
        configResolved(config) {
            if (process.env.VITE_LUNORA_URL) {
                return;
            }

            const origin = `http://localhost:${config.server.port ?? 3000}`;

            // Assign INTO `define` rather than replacing it: `ResolvedConfig.define`
            // is a readonly property. Vite has always populated it by this point,
            // so the guard is only here to satisfy its optional type.
            if (config.define) {
                config.define["import.meta.env.VITE_LUNORA_URL"] = JSON.stringify(origin);
            }
        },
        name: "lunora-ssr-origin",
    };
};

/**
 * Plugin ordering for Next.js-on-Vite (vinext) composed with Lunora:
 *  1. vinext()           — reimplements the Next.js App Router on Vite and wires
 *                          React Server Components internally (no manual
 *                          `@vitejs/plugin-rsc` entry needed — vinext configures it).
 *  2. cloudflare()       — the worker entry runs in the `rsc` Vite environment
 *                          with `ssr` as a child, matching vinext's RSC topology.
 *  3. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 2 above).
 *
 * The `virtual:lunora/worker` entry (set in wrangler.jsonc `main`) is resolved by
 * Lunora's frameworkComposePlugin: it emits a composed worker that routes
 * `/_lunora/*` to Lunora and delegates everything else to vinext's router-selected SSR
 * handler (`vinext/server/fetch-handler`, a `{ fetch(request, env, ctx) }`
 * worker). One worker, one deploy, one `ShardDO` namespace.
 */
export default defineConfig({
    // `allowUnauthenticatedShardAccess: true` is a DEMO default: the composed
    // worker default-denies client-named shard access (403), so the scaffold's
    // auth-less `.shardBy("channelId")` schema needs this to work — data is
    // protected by per-row RLS. A PRODUCTION sharded app should drop it and
    // configure `authorizeShard` in a hand-written worker instead.
    plugins: [
        vinext(),
        cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }),
        lunora({ allowUnauthenticatedShardAccess: true, cloudflare: false }),
        ssrOrigin(),
    ],
});
