import { cloudflare } from "@cloudflare/vite-plugin";
import { lunora } from "@lunora/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Plugin order is load-bearing on Cloudflare:
 *
 * 1. `cloudflare()` must come first so it owns the `ssr` Vite environment before
 *    `tanstackStart()` configures it.
 * 2. `tanstackStart()` generates the SSR + client entries and the route tree.
 * 3. `react()` does the JSX transform.
 * 4. `lunora({ cloudflare: false })` adds codegen, wrangler validation and the
 *    studio overlay — `cloudflare: false` because the plugin is already at
 *    position 0.
 *
 * `wrangler.jsonc`'s `main` is `virtual:lunora/worker`, which Lunora's compose
 * plugin resolves into a worker that routes `/_lunora/*` to Lunora and
 * everything else to the TanStack Start SSR handler.
 */
export default defineConfig({
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), lunora({ cloudflare: false })],
    resolve: {
        // Vite 8 resolves tsconfig paths natively.
        tsconfigPaths: true,
    },
});
