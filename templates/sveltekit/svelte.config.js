import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * SvelteKit config. `@sveltejs/adapter-cloudflare` builds SvelteKit's server
 * into a Cloudflare Worker handler emitted at `.svelte-kit/cloudflare/_worker.js`.
 *
 * Cirrus does NOT replace that build (SvelteKit is a Class-B framework — it owns
 * its own CF adapter). Instead `src/worker.ts` imports the adapter's emitted
 * handler and wraps it with `withCirrus` (see `@cirrus/svelte/worker`), then
 * `wrangler.jsonc`'s `main` points at `src/worker.ts` so the deployed Worker is
 * the composed single worker: SvelteKit + Cirrus realtime under `/_cirrus/*`.
 *
 * @type {import("@sveltejs/kit").Config}
 */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        // Emits `.svelte-kit/cloudflare/_worker.js` — the handler `src/worker.ts`
        // wraps. `routes.include`/`exclude` stay default; Cirrus's `/_cirrus/*`
        // is handled in `src/worker.ts`, never by SvelteKit's router.
        adapter: adapter(),
    },
};

export default config;
