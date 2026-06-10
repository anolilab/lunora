import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { cirrus } from "@cirrus/astro";
import { defineConfig } from "astro/config";

// Astro is multi-framework at the UI layer, so Cirrus reactivity comes from the
// island adapter you pick — here React (`@cirrus/react`). The `cirrus()`
// integration declares the Cirrus composition seam; `@astrojs/cloudflare`
// builds the server worker, which `src/worker.ts` wraps with `withCirrus` so
// Cirrus realtime mounts under `/_cirrus/*` inside that same worker.
export default defineConfig({
    adapter: cloudflare(),
    integrations: [react(), cirrus()],
    output: "server",
});
