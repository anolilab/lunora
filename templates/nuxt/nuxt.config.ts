import { lunora } from "@lunora/vite";

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: "2026-04-07",

    // Nuxt 4 defaults `srcDir` to `app/`. This template keeps app code at the
    // project root (`app.vue`, `pages/`, `components/`, `plugins/`), so pin
    // `srcDir` to `.` explicitly — deterministic layout, no compat warning.
    srcDir: ".",

    // Single-worker composition (via `@lunora/nuxt`): Lunora realtime
    // (`/_lunora/*` RPC + WebSocket + admin) is mounted *inside* Nitro as a
    // server route, so the whole app — Nuxt SSR + Lunora — ships as ONE
    // Cloudflare Worker and one deploy. The `@lunora/nuxt` module registers the
    // `/_lunora/**` handler and aliases the `#lunora/app` virtual to
    // `lunora/server`; the `ShardDO` Durable Object class reaches the worker
    // entrypoint via the project-root `exports.cloudflare.ts`.
    modules: ["@lunora/nuxt"],

    // Nitro emits a Cloudflare module worker (`.output/server/index.mjs`); the
    // `cloudflare_module` preset appends `exports.cloudflare.ts`'s exports onto it.
    nitro: {
        preset: "cloudflare_module",
    },

    // Run Lunora codegen during the Nuxt/Vite build so `lunora/_generated/`
    // is present when page components and server routes import the typed API.
    // `cloudflare: false` — Nuxt uses its own CF adapter (Nitro preset) and
    // doesn't need @cloudflare/vite-plugin wired through here.
    // `validateWrangler: false` — validation happens at deploy time (the single
    // `wrangler.jsonc`'s `main` is Nitro's output, which only exists post-build).
    vite: {
        plugins: [lunora({ cloudflare: false, validateWrangler: false })],
    },
});
