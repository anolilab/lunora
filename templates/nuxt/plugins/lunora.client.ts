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
    const config = useRuntimeConfig();

    // Empty `lunoraUrl` → same origin as the page (the common single-worker
    // deploy). Point it at a remote worker for split deploys.
    const url = config.public.lunoraUrl || window.location.origin;

    const client = new LunoraClient({ url });

    nuxtApp.vueApp.use(createLunora(client));
});
