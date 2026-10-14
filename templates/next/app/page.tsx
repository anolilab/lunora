import { createServerClient, preloadQuery } from "@lunora/react/server";
import { headers } from "next/headers";

import { MessageFeed } from "../components/message-feed";
import { api } from "../lunora/_generated/api";

const channelId = "channel:demo" as const;

/**
 * React Server Component: runs the Lunora query once on the server and hands a
 * serializable `Preloaded` token to a client component — the server half of the
 * preload handoff. `@lunora/react/server` carries no "use client" directive and
 * opens no WebSocket, so it is safe to import here; the client component calls
 * `usePreloadedQuery` to seed the first paint (no loading flash) and then
 * attach a live WebSocket subscription.
 *
 * Identity continuity: the incoming request's `Cookie` header is forwarded on
 * every outgoing RPC so the Lunora worker auth middleware sees the same session.
 *
 * Two-worker split: the Lunora realtime plane lives in a SEPARATE worker
 * (the root `wrangler.jsonc`). The RSC loader reaches `/_lunora/rpc` via
 * NEXT_PUBLIC_LUNORA_URL; the localhost fallback matches `wrangler dev`'s
 * default port during local dev, and is development-only so a production
 * deployment with the variable unset fails loudly instead of silently
 * resolving to a machine-local address.
 */
export default async function HomePage() {
    const lunoraUrl = process.env.NEXT_PUBLIC_LUNORA_URL ?? (process.env.NODE_ENV === "development" ? "http://localhost:8787" : undefined);

    if (!lunoraUrl) {
        throw new Error("NEXT_PUBLIC_LUNORA_URL must be set — it is inlined at build time.");
    }

    // Forward the browser's Cookie header so the server-side load runs as the
    // signed-in user (cross-origin call, but the session token travels along).
    // Reading `headers()` also opts this page into per-request dynamic rendering.
    const cookie = (await headers()).get("cookie");

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const requestHeaders = new Headers(init?.headers);

        if (cookie) {
            requestHeaders.set("cookie", cookie);
        }

        return fetch(input, { ...init, headers: requestHeaders });
    };

    const client = createServerClient({ fetch: cookieForwardingFetch, url: lunoraUrl });

    // `channelId` is the shard key because the schema declares
    // `.shardBy("channelId")` on the messages table — routes the HTTP RPC to the
    // correct Durable Object shard without a resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return (
        <main style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
            <p>Next.js + Lunora realtime queries — your Server Component load is live.</p>
            <MessageFeed preloaded={preloaded} />
        </main>
    );
}
