import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// SvelteKit owns its Vite build (class-B). `@sveltejs/kit/vite` wires the
// SvelteKit plugin; `cirrus codegen` runs separately (the `codegen` script) and
// the single-worker composition happens at build/deploy time via `src/worker.ts`
// + `wrangler.jsonc` — see the README and the class-B notes in the docs.
export default defineConfig({ plugins: [sveltekit()] });
