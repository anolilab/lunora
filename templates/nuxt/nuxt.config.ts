// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
    compatibilityDate: "2026-04-07",

    // Nuxt is a CLASS-B framework (PLAN4 §3): it owns its own Cloudflare
    // adapter via Nitro. The Cirrus realtime worker (`/_cirrus/*`) is composed
    // into Nitro's CF preset in PLAN4 M4 — see README ("Class-B composition").
    // Until then this template runs Nuxt's SSR + the Cirrus worker side by side
    // (the `cirrus dev` script wires both under one origin for local dev).
    nitro: {
        preset: "cloudflare-pages",
    },

    runtimeConfig: {
        // Server-only: base URL of the Cirrus worker the SSR loader reaches over
        // HTTP RPC. Defaults to the local `wrangler dev` worker.
        cirrusWorkerUrl: "http://localhost:8787",
        public: {
            // Client-side: the worker origin the browser `CirrusClient` connects
            // its WebSocket to. Empty string = same origin as the page.
            cirrusUrl: "",
        },
    },
});
