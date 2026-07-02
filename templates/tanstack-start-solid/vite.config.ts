import { lunora } from "@lunora/vite";
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
 *  4. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 0 above).
 *
 * The `virtual:lunora/worker` entry (set in wrangler.jsonc `main`) is resolved
 * by the frameworkComposePlugin inside lunora() — it emits a composed worker
 * that routes `/_lunora/*` to Lunora and everything else to the TanStack Start
 * SSR handler (@tanstack/solid-start/server-entry).
 */
export default defineConfig({
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
    // `allowUnauthenticatedShardAccess: true` is a DEMO default: the composed
    // worker default-denies client-named shard access (403), so an auth-less
    // `.shardBy(...)` demo needs this to work — data is protected by per-row RLS.
    // A PRODUCTION sharded app should drop it and configure `authorizeShard` in a
    // hand-written worker instead.
    plugins: [
        cloudflare({ viteEnvironment: { name: "ssr" } }),
        tanstackStart(),
        solidPlugin({ ssr: true }),
        lunora({ allowUnauthenticatedShardAccess: true, cloudflare: false }),
    ],
});
