import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

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
 * `/_lunora/*` to Lunora and delegates everything else to vinext's App-Router SSR
 * handler (`vinext/server/app-router-entry`, a `{ fetch(request, env, ctx) }`
 * worker). One worker, one deploy, one `ShardDO` namespace.
 */
export default defineConfig({
    plugins: [vinext(), cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] } }), lunora({ cloudflare: false })],
});
