import type { Preloaded, ReturnOf } from "@cirrus/client";
import { createServerClient, preloadQuery } from "@cirrus/vue/server";

import { api } from "../../cirrus/_generated/api";

const channelId = "channel:demo" as const;

/**
 * Server route that runs the Cirrus query once during SSR and returns a
 * serializable `Preloaded` token — the server half of PLAN4's reactive-loader
 * handoff. The page fetches this with `useFetch` (so it runs on the server and
 * the result is embedded in the SSR payload), then hands the token to
 * `hydratePreloaded` on the client for a no-flash, seed-then-subscribe handoff.
 *
 * Identity continuity (PLAN4 §5 #2): we forward the incoming request's `Cookie`
 * header on every outgoing RPC so the worker-side auth middleware sees the same
 * session the browser has — no separate token exchange on the same origin.
 */
export default defineEventHandler(async (event): Promise<{ preloaded: Preloaded<ReturnOf<typeof api.messages.list>> }> => {
    const config = useRuntimeConfig(event);

    // Forward the browser's Cookie header so the SSR load runs as the signed-in
    // user (same-origin, same session).
    const cookie = getHeader(event, "cookie");

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...init, headers });
    };

    const client = createServerClient({ fetch: cookieForwardingFetch, url: config.cirrusWorkerUrl });

    // `channelId` is the shard key because the schema declares
    // `.shardBy("channelId")` on the messages table — routes the HTTP RPC to the
    // correct Durable Object shard without a resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded };
});
