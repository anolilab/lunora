import { lunora } from "@lunora/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

/**
 * Plugin ordering is load-bearing on Cloudflare:
 *  1. cloudflare()       — must come first so it owns the "ssr" Vite environment
 *                          before reactRouter() configures it.
 *  2. reactRouter()      — React Router v7 framework mode: generates the SSR +
 *                          client entries and the `virtual:react-router/server-build`
 *                          module from `app/routes.ts` (+ `react-router.config.ts`).
 *  3. lunora({cloudflare:false}) — codegen, wrangler validation, studio overlay.
 *                          `cloudflare: false` tells Lunora not to re-add
 *                          @cloudflare/vite-plugin (it's already position 0 above).
 *
 * The `virtual:lunora/worker` entry (set in wrangler.jsonc `main`) is resolved
 * by the frameworkComposePlugin inside lunora() — it emits a composed worker
 * that routes `/_lunora/*` to Lunora and everything else to React Router's SSR
 * handler (`createRequestHandler` over `virtual:react-router/server-build`).
 *
 * React Router v7 supports Vite 8; no separate JSX-transform plugin is needed —
 * `reactRouter()` configures the React JSX runtime itself.
 */
export default defineConfig({
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter(), lunora({ cloudflare: false })],
});
