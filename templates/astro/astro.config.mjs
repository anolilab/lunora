import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { lunora } from "@lunora/astro";
import { lunora as lunoraVite } from "@lunora/vite";
import { defineConfig } from "astro/config";

// Astro is multi-framework at the UI layer, so Lunora reactivity comes from the
// island adapter you pick — here React (`@lunora/react`). The `lunora()`
// integration declares the Lunora composition seam; `@astrojs/cloudflare`
// builds the server worker from `src/server.ts` (wrangler.jsonc's `main`), which
// composes the adapter handler into the Lunora app with `.buildFrameworkWorker()`
// so Lunora realtime mounts under `/_lunora/*` inside that same worker.
export default defineConfig({
    adapter: cloudflare(),
    integrations: [react(), lunora()],
    output: "server",

    // `astro dev` runs the whole app — SSR + `/_lunora/*` + the `ShardDO`
    // Durable Object — in `workerd` via `@astrojs/cloudflare`'s embedded
    // `@cloudflare/vite-plugin` (Astro 6+), so a single `lunora dev` gives you
    // realtime + HMR with no sidecar. `@lunora/vite`'s codegen / Studio /
    // dev-state plugins are added here with `cloudflare: false` so they run
    // inside that same dev server WITHOUT wiring a SECOND `@cloudflare/vite-plugin`
    // (which would collide with the adapter's). `validateWrangler: false` because
    // wrangler validation is a deploy-time concern (the adapter owns dev).
    vite: { plugins: [lunoraVite({ cloudflare: false, validateWrangler: false })] },
});
