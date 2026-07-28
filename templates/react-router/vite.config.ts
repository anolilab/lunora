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
    environments: {
        // Vite names an environment's output directory after the environment, so
        // `cloudflare({ viteEnvironment: { name: "ssr" } })` below would emit to
        // `dist/ssr`. React Router reads its server manifest from
        // `<buildDirectory>/server`, so pin the output there instead of renaming
        // the environment — the Cloudflare plugin has to keep owning `ssr`.
        ssr: { build: { outDir: "dist/server" } },
    },
    resolve: {
        // Vite 8 resolves tsconfig paths natively — no vite-tsconfig-paths plugin needed.
        tsconfigPaths: true,
    },
    // `allowUnauthenticatedShardAccess: true` is a DEMO default: the composed
    // worker default-denies client-named shard access (403), so an auth-less
    // `.shardBy(...)` demo needs this to work — data is protected by per-row RLS.
    // A PRODUCTION sharded app should drop it and configure `authorizeShard` in a
    // hand-written worker instead.
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), reactRouter(), lunora({ allowUnauthenticatedShardAccess: true, cloudflare: false })],
});
