import { lunora } from "@lunora/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// SvelteKit owns its Vite build (class-B). `@sveltejs/kit/vite` wires the
// SvelteKit plugin; `lunora()` runs codegen so `lunora/_generated/` is present
// at build time for page routes that import the typed API. The cloudflare and
// wrangler-validator features are disabled here because SvelteKit uses its own
// CF adapter (`@sveltejs/adapter-cloudflare`) for deployment — those features
// are used only by `lunora deploy`, which reads `wrangler.jsonc` independently.
//
// Class-B note (PLAN4 §3): `src/worker.ts` wraps the adapter-emitted handler
// with `withLunora` for the deployed single-worker composition; it is only
// referenced by `lunora deploy`, not by the `vite build` here.
export default defineConfig({ plugins: [lunora({ cloudflare: false, validateWrangler: false }), sveltekit()] });
