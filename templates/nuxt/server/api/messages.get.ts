import type { Preloaded, ReturnOf } from "lunorash/client";
import { createServerClient, preloadQuery } from "@lunora/vue/server";

import { api } from "../../lunora/_generated/api";

const channelId = "channel:demo" as const;

/**
 * Server route that runs the Lunora query once during SSR and returns a
 * serializable `Preloaded` token — the server half of the reactive-loader
 * handoff. The page fetches this with `useFetch` (so it runs on the server and
 * the result is embedded in the SSR payload), then hands the token to
 * `hydratePreloaded` on the client for a no-flash, seed-then-subscribe handoff.
 *
 * Single-worker: Lunora is mounted in this same Nitro worker by `@lunora/nuxt`,
 * so the SSR client reaches `/_lunora/rpc` at the request's own origin (a
 * same-origin sub-request that Nitro routes back into the in-process Lunora app).
 * We forward the incoming `Cookie` header on every RPC so the Lunora worker's
 * auth middleware sees the same session.
 */
export default defineEventHandler(async (event): Promise<{ preloaded: Preloaded<ReturnOf<typeof api.messages.list>> }> => {
    // Same-origin self-call: derive the base URL from the inbound request. The
    // server client appends `/_lunora/rpc`, which the `@lunora/nuxt` route serves.
    const origin = getRequestURL(event).origin;

    // Forward the browser's Cookie header so the SSR load runs as the signed-in
    // user (the session token rides along on the in-worker RPC).
    const cookie = getHeader(event, "cookie");

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...init, headers });
    };

    const client = createServerClient({ fetch: cookieForwardingFetch, url: origin });

    // `channelId` is the shard key because the schema declares
    // `.shardBy("channelId")` on the messages table — routes the HTTP RPC to the
    // correct Durable Object shard without a resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded };
});
