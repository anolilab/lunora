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
 * Identity continuity: we forward the incoming request's `Cookie` header on
 * every outgoing RPC so the Lunora worker auth middleware sees the same session.
 *
 * Two-worker split: the Lunora realtime plane lives in a SEPARATE Worker
 * (`wrangler.lunora.jsonc`). The SSR loader reaches `/_lunora/rpc` via the URL
 * configured in `runtimeConfig.public.lunoraUrl` (NUXT_PUBLIC_LUNORA_URL).
 */
export default defineEventHandler(async (event): Promise<{ preloaded: Preloaded<ReturnOf<typeof api.messages.list>> }> => {
    const config = useRuntimeConfig(event);

    // Two-worker split: lunoraUrl points at the standalone Lunora worker.
    // Set NUXT_PUBLIC_LUNORA_URL to the deployed Lunora worker URL.
    const lunoraUrl = config.public.lunoraUrl as string;

    if (!lunoraUrl) {
        throw createError({ statusCode: 500, message: "NUXT_PUBLIC_LUNORA_URL is not set — configure it to point at the Lunora worker URL." });
    }

    // Forward the browser's Cookie header so the SSR load runs as the signed-in
    // user (cross-origin call, but session token is forwarded explicitly).
    const cookie = getHeader(event, "cookie");

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...init, headers });
    };

    const client = createServerClient({ fetch: cookieForwardingFetch, url: lunoraUrl });

    // `channelId` is the shard key because the schema declares
    // `.shardBy("channelId")` on the messages table — routes the HTTP RPC to the
    // correct Durable Object shard without a resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded };
});
