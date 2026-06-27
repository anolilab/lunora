import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import vinext from "vinext";
import { defineConfig } from "vite";

/**
 * Plugin ordering for Next.js Pages Router on Vite (vinext) composed with Lunora:
 *  1. vinext()           — reimplements the Next.js Pages Router on Vite (no RSC
 *                          environment — the Pages Router doesn't use React Server
 *                          Components, so this is a plain `cloudflare()` below).
 *  2. cloudflare()       — builds the worker (`worker/index.ts`) for Cloudflare.
 *  3. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 2 above).
 *
 * Unlike the App-Router template, the Pages Router has no clean importable SSR
 * handler — vinext drives the 9-step Next.js request pipeline through build-time
 * virtual modules (`virtual:vinext-server-entry`, …). So `worker/index.ts` is a
 * hand-wired single worker: it folds vinext's generated Pages worker
 * (`worker/vinext-pages.ts`) in as the framework host via the generated
 * `defineApp().buildFrameworkWorker()`, and `vinext build` resolves the virtuals.
 */
export default defineConfig({
    plugins: [vinext(), cloudflare(), lunora({ cloudflare: false })],
});
