import { cirrus } from "@cirrus/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: "2026-04-07",

    // Nuxt 4 defaults `srcDir` to `app/`. This template keeps app code at the
    // project root (`app.vue`, `pages/`, `components/`, `plugins/`), so pin
    // `srcDir` to `.` explicitly — deterministic layout, no compat warning.
    srcDir: ".",

    // Nuxt is a CLASS-B framework (PLAN4 §3): it owns its own Cloudflare adapter
    // via Nitro. PLAN4 M4 composes Cirrus realtime (`/_cirrus/*` + ShardDO) INTO
    // Nitro's emitted Worker via `withCirrus` (`@cirrus/vue/worker`) — see
    // `server/cirrus-entry.ts` + the README ("Class-B composition"). The
    // `cloudflare-module` preset is used because it lets us supply a custom
    // server entry that wraps Nitro's handler; `entrypoint` points Wrangler's
    // build at the composed entry, and `wrangler.jsonc`'s `main` matches it.
    nitro: {
        cloudflare: {
            // The composed single-worker entry (wraps Nitro's handler with
            // `withCirrus`, re-exports `ShardDO`). Adjust the option name to your
            // Nitro version's custom-entry hook if it differs.
            entrypoint: "~/server/cirrus-entry",
        },
        preset: "cloudflare-module",
    },

    runtimeConfig: {
        public: {
            // Client-side: the worker origin the browser `CirrusClient` connects
            // its WebSocket to. Empty string = same origin as the page — which is
            // now the common case, since Cirrus realtime is co-located in the
            // SAME Worker as Nuxt (single-worker composition, M4).
            cirrusUrl: "",
        },
    },

    // Run Cirrus codegen during the Nuxt/Vite build so `cirrus/_generated/`
    // is present when page components and server routes import the typed API.
    // `cloudflare: false` — Nuxt uses its own CF adapter (Nitro preset) and
    // doesn't need @cloudflare/vite-plugin wired through here.
    // `validateWrangler: false` — the wrangler main field points at Nitro's
    // emitted output (.output/server/index.mjs) which doesn't exist until
    // after the build completes; validation happens at `cirrus deploy` time.
    vite: {
        plugins: [cirrus({ cloudflare: false, validateWrangler: false })],
    },
});
