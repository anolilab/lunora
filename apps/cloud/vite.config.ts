import { cloudflare } from "@cloudflare/vite-plugin";
import { lunora } from "@lunora/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * The control-plane Worker (`src/server.ts`) plus the hosted studio, now a
 * TanStack Start app rather than a CSR-only SPA.
 *
 * Plugin ordering is load-bearing on Cloudflare (same as
 * `templates/tanstack-start-react`):
 *  1. cloudflare()    — must come first so it owns the "ssr" Vite environment
 *                       before tanstackStart() configures it.
 *  2. tanstackStart() — generates the SSR + client entries and the route tree
 *                       (reads `tsr.config.json`, which targets React).
 *  3. react()         — JSX transform.
 *  4. lunora({ cloudflare: false }) — codegen, wrangler validation, studio
 *                       overlay. `cloudflare: false` because the CF plugin is
 *                       already at position 0; re-adding it would fight over the
 *                       "ssr" environment.
 *
 * Unlike the template, `wrangler.jsonc` keeps `main: "src/server.ts"` rather than
 * pointing at `virtual:lunora/worker`. That generated virtual entry composes the
 * SSR handler for apps with no worker of their own, but this app's entry is
 * substantial — dispatcher routing, the deploy API, the admin proxy, the auth
 * handler, the tail consumer, cron fan-out and the queue consumer — so it stays
 * hand-written and mounts the SSR handler itself (see `src/server.ts`).
 */
export default defineConfig({
    plugins: [cloudflare({ viteEnvironment: { name: "ssr" } }), tanstackStart(), react(), lunora({ cloudflare: false })],
    server: { port: 5174 },
});
