import { LunoraClient } from "lunorash/client";
import { createLunora } from "@lunora/vue";

/**
 * Universal Nuxt plugin: builds the `LunoraClient` and provides it to the whole
 * app via `@lunora/vue`'s `createLunora` plugin. Every `useQuery` /
 * `useMutation` / `hydratePreloaded` call resolves this instance through
 * `provide`/`inject`.
 *
 * Deliberately NOT `lunora.client.ts`. Every `@lunora/vue` composable calls
 * `useLunora()` unconditionally, and that throws when no client is injected — so
 * a client-only plugin left the server render with no provider at all and the
 * first SSR'd page touching Lunora 500'd. Providing the client on the server
 * costs nothing: the composables gate the WebSocket on a browser `window`
 * themselves, so the socket still opens only after hydration and SSR renders the
 * preloaded seed.
 */
export default defineNuxtPlugin((nuxtApp) => {
    // Prod (single-worker deploy): Lunora is mounted in this same Nitro worker by
    // `@lunora/nuxt`, so the client talks to the page's own origin — it appends
    // `/_lunora/ws` (and `/_lunora/rpc`) itself, which the module's route serves.
    // `useRequestURL()` resolves that origin on both sides: from the incoming
    // request during SSR, from `window.location` in the browser.
    //
    // Dev: `nuxt dev` (Node) can't host the `ShardDO` Durable Object, so
    // `lunora dev` runs a `wrangler dev` sidecar (:8788, see `wrangler.dev.jsonc`)
    // that owns it. Point the client straight at that sidecar in dev — RPC + the
    // WebSocket hit `workerd` directly with no Node hop. The sidecar's
    // `LUNORA_ALLOWED_ORIGINS` allows this cross-origin request.
    const url = import.meta.dev ? "http://localhost:8788" : useRequestURL().origin;
    const client = new LunoraClient({ url });

    nuxtApp.vueApp.use(createLunora(client));
});
