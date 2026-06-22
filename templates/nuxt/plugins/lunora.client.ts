import { LunoraClient } from "lunorash/client";
import { createLunora } from "@lunora/vue";

/**
 * Client-only Nuxt plugin (`.client.ts`): builds the browser `LunoraClient` and
 * provides it to the whole app via `@lunora/vue`'s `createLunora` plugin. Every
 * `useQuery` / `useMutation` / `hydratePreloaded` call resolves this instance
 * through `provide`/`inject`.
 *
 * The client opens its WebSocket lazily on the first subscription, so creating
 * it here (rather than in SSR) keeps the socket strictly browser-side — exactly
 * what the reactive-loader handoff wants: SSR fetched over HTTP, the live feed
 * attaches after hydration.
 */
export default defineNuxtPlugin((nuxtApp) => {
    // Single-worker deploy: Lunora is mounted in this same Nitro worker by
    // `@lunora/nuxt`, so the client talks to the page's own origin — it appends
    // `/_lunora/ws` (and `/_lunora/rpc`) itself, which the module's route serves.
    const client = new LunoraClient({ url: window.location.origin });

    nuxtApp.vueApp.use(createLunora(client));
});
