import { cloudflare } from "@cloudflare/vite-plugin";
import { cirrus } from "@cirrus/vite";
import react from "@vitejs/plugin-react";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { defineConfig } from "vite";

/**
 * Plugin ordering is load-bearing on Cloudflare:
 *  1. cloudflare()       — must come first so it owns the "ssr" Vite environment
 *                          before tanstackStart() configures it.
 *  2. tanstackStart()    — generates the SSR + client entry points + route tree.
 *  3. react()            — JSX transform.
 *  4. cirrus({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Cirrus not to re-add
 *                          @cloudflare/vite-plugin (it's already position 0 above).
 *
 * The `virtual:cirrus/worker` entry (set in wrangler.jsonc `main`) is resolved
 * by the frameworkComposePlugin inside cirrus() — it emits a composed worker
 * that routes `/_cirrus/*` to Cirrus and everything else to the TanStack Start
 * SSR handler (@tanstack/react-start/server-entry).
 */
export default defineConfig({
    plugins: [
        cloudflare({ viteEnvironment: { name: "ssr" } }),
        tanstackStart({ tsr: { srcDirectory: "src" } }),
        react(),
        cirrus({ cloudflare: false }),
    ],
});
