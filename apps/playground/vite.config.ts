import { lunora } from "@lunora/vite";
import { defineConfig } from "vite";

// In the e2e harness we keep the single embedded worker (prod parity) but make
// its Miniflare storage ephemeral (`persistState: false`) so each run starts
// from a clean DO / D1 / R2 — no state leaking across runs, and the developer's
// own `.wrangler/state` is left untouched.
const e2e = process.env.LUNORA_E2E === "true";

export default defineConfig({
    plugins: [lunora(e2e ? { cloudflare: { persistState: false } } : undefined)],
    server: {
        port: 5173,
    },
});
