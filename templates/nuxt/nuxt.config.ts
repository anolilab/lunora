import { cirrus } from "@cirrus/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: "2026-04-07",

    // Nuxt 4 defaults `srcDir` to `app/`. This template keeps app code at the
    // project root (`app.vue`, `pages/`, `components/`, `plugins/`), so pin
    // `srcDir` to `.` explicitly — deterministic layout, no compat warning.
    srcDir: ".",

    // Two-worker split: Nuxt uses the standard `cloudflare_module` Nitro preset
    // with no custom entrypoint. Cirrus realtime (`/_cirrus/*` + ShardDO) runs in
    // a SEPARATE Cloudflare Worker — see `wrangler.cirrus.jsonc` + `cirrus/server.ts`.
    //
    // Why two workers? Nitro does not expose its emitted fetch handler as an
    // importable virtual module (`#nitro-cloudflare-handler` is not a real
    // specifier). `nitro.cloudflare.entrypoint` is also undocumented and absent
    // from the Nitro API surface. Without a documented hook to intercept Nitro's
    // handler, composing `/_cirrus/*` into the Nitro output is not achievable
    // through any supported mechanism. The two-worker split is the documented path.
    nitro: {
        preset: "cloudflare_module",
    },

    runtimeConfig: {
        public: {
            // URL of the separate Cirrus worker. Required in production — set via
            // NUXT_PUBLIC_CIRRUS_URL (e.g. https://my-app-cirrus.workers.dev).
            // During local dev: run `wrangler dev --config wrangler.cirrus.jsonc`
            // in a second terminal and set
            //   NUXT_PUBLIC_CIRRUS_URL=http://localhost:8788
            // (or whatever port wrangler dev assigns) in `.dev.vars`.
            cirrusUrl: "",
        },
    },

    // Run Cirrus codegen during the Nuxt/Vite build so `cirrus/_generated/`
    // is present when page components and server routes import the typed API.
    // `cloudflare: false` — Nuxt uses its own CF adapter (Nitro preset) and
    // doesn't need @cloudflare/vite-plugin wired through here.
    // `validateWrangler: false` — validation happens at `cirrus deploy` time
    // (wrangler.cirrus.jsonc's main is `cirrus/server.ts`, built by wrangler).
    vite: {
        plugins: [cirrus({ cloudflare: false, validateWrangler: false })],
    },
});
