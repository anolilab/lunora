import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * SvelteKit config. `@sveltejs/adapter-cloudflare` builds SvelteKit's server
 * into a Cloudflare Worker handler emitted at `.svelte-kit/cloudflare/_worker.js`.
 *
 * Lunora does NOT replace that build (SvelteKit is a Class-B framework — it owns
 * its own CF adapter). The adapter overwrites whatever `wrangler.jsonc`'s `main`
 * points at, so `main` stays on the adapter's own `_worker.js`. `src/worker.ts`
 * imports that emitted handler, wraps it with `withLunora` (see
 * `@lunora/svelte/worker`), and `lunora deploy` bundles `src/worker.ts` as the
 * deploy entry (overriding `main`) so the deployed Worker is the composed single
 * worker: SvelteKit + Lunora realtime under `/_lunora/*`.
 *
 * @type {import("@sveltejs/kit").Config}
 */
const config = {
    preprocess: vitePreprocess(),
    kit: {
        // Emits `.svelte-kit/cloudflare/_worker.js` — the handler `src/worker.ts`
        // wraps. `routes.include`/`exclude` stay default; Lunora's `/_lunora/*`
        // is handled in `src/worker.ts`, never by SvelteKit's router.
        adapter: adapter(),
    },
};

export default config;
