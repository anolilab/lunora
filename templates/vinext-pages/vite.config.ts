import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

/**
 * Plugin ordering for Next.js Pages Router on Vite (vinext) composed with Lunora:
 *  1. vinext()           — reimplements the Next.js Pages Router on Vite. No RSC
 *                          environment: the Pages Router doesn't use React Server
 *                          Components, so this is a plain `cloudflare()` below
 *                          (the App-Router template passes `viteEnvironment`).
 *  2. cloudflare()       — builds the worker for Cloudflare.
 *  3. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 2 above).
 *
 * The `virtual:lunora/worker` entry (set in wrangler.jsonc `main`) is resolved by
 * Lunora's frameworkComposePlugin: it emits a composed worker that routes
 * `/_lunora/*` to Lunora and delegates everything else to vinext's router-selected
 * SSR handler (`vinext/server/fetch-handler`, a `{ fetch(request, env, ctx) }`
 * worker). One worker, one deploy, one `ShardDO` namespace.
 */
export default defineConfig({
    plugins: [vinext(), cloudflare(), lunora({ cloudflare: false })],
});
