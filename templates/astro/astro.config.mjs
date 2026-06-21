import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { lunora } from "@lunora/astro";
import { defineConfig } from "astro/config";

// Astro is multi-framework at the UI layer, so Lunora reactivity comes from the
// island adapter you pick — here React (`@lunora/react`). The `lunora()`
// integration declares the Lunora composition seam; `@astrojs/cloudflare`
// builds the server worker, which `src/worker.ts` wraps with `withLunora` so
// Lunora realtime mounts under `/_lunora/*` inside that same worker.
export default defineConfig({
    adapter: cloudflare(),
    integrations: [react(), lunora()],
    output: "server",
});
