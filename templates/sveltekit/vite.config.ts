import { cirrus } from "@cirrus/vite";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// SvelteKit owns its Vite build (class-B). `@sveltejs/kit/vite` wires the
// SvelteKit plugin; `cirrus()` runs codegen so `cirrus/_generated/` is present
// at build time for page routes that import the typed API. The cloudflare and
// wrangler-validator features are disabled here because SvelteKit uses its own
// CF adapter (`@sveltejs/adapter-cloudflare`) for deployment — those features
// are used only by `cirrus deploy`, which reads `wrangler.jsonc` independently.
//
// Class-B note (PLAN4 §3): `src/worker.ts` wraps the adapter-emitted handler
// with `withCirrus` for the deployed single-worker composition; it is only
// referenced by `cirrus deploy`, not by the `vite build` here.
export default defineConfig({ plugins: [cirrus({ cloudflare: false, validateWrangler: false }), sveltekit()] });
