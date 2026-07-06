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
//
// Dev (`lunora dev`): this Vite server is the front door (:5173, SSR + HMR).
// `lunora dev` also starts a `wrangler dev` sidecar (`wrangler.dev.jsonc`, :8787)
// that owns the real `ShardDO` — SvelteKit's Node dev server can't host a
// Durable Object. The `server.proxy` below forwards `/_lunora/*` (RPC + the
// WebSocket, `ws: true`) to that sidecar, so the browser `LunoraClient` stays
// same-origin (:5173) and needs no CORS. Vite's own HMR socket is unaffected.
// `127.0.0.1` (not `localhost`) sidesteps the Node `::1`-first resolution bug.
export default defineConfig({
    plugins: [lunora({ cloudflare: false, validateWrangler: false }), sveltekit()],
    server: {
        proxy: {
            "/_lunora": { changeOrigin: true, target: "http://127.0.0.1:8787", ws: true },
        },
    },
});
