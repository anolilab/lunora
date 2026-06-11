import { cirrus } from "@cirrus/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/solid-start/plugin/vite";
import solidPlugin from "vite-plugin-solid";
import { defineConfig } from "vite";

/**
 * Plugin ordering is load-bearing on Cloudflare:
 *  1. cloudflare()       — must come first so it owns the "ssr" Vite environment
 *                          before tanstackStart() configures it.
 *  2. tanstackStart()    — generates the SSR + client entry points + route tree
 *                          (reads `tsr.config.json`, which targets Solid).
 *  3. solidPlugin()      — Solid JSX transform + SSR hydration.
 *  4. cirrus({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Cirrus not to re-add
 *                          @cloudflare/vite-plugin (it's already position 0 above).
 *
 * The `virtual:cirrus/worker` entry (set in wrangler.jsonc `main`) is resolved
 * by the frameworkComposePlugin inside cirrus() — it emits a composed worker
 * that routes `/_cirrus/*` to Cirrus and everything else to the TanStack Start
 * SSR handler (@tanstack/solid-start/server-entry).
 */
export default defineConfig({
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), solidPlugin({ ssr: true }), cirrus({ cloudflare: false })],
});
