import type { Preloaded, ReturnOf } from "@cirrus/svelte/server";
import { createServerClient, preloadQuery } from "@cirrus/svelte/server";

import { api } from "../../cirrus/_generated/api";
import type { PageLoad } from "./$types";

const channelId = "channel:demo" as const;

/**
 * SvelteKit universal load: runs on the server for the initial request (and on
 * the client for subsequent client-side navigations). Here it does the
 * server-side preload that powers the reactive-loader handoff.
 *
 * It builds a request-scoped `CirrusClient` that uses the HTTP RPC path
 * (`/_cirrus/rpc`) — no WebSocket, no in-process Durable Object access — and
 * forwards SvelteKit's `fetch` so the request carries the same-origin session
 * cookie (PLAN4 open question #2: identity continuity SSR→client). `preloadQuery`
 * returns a serializable `Preloaded` token that SvelteKit embeds in the SSR HTML.
 *
 * `channelId` is the shard key because the schema declares `.shardBy("channelId")`
 * on the messages table, so the HTTP RPC routes to the correct Durable Object
 * shard server-side (PLAN4 open question #6).
 *
 * The call is **same-origin**: under the Class-B composition (`src/worker.ts`'s
 * `withCirrus`), Cirrus realtime is mounted under `/_cirrus/*` inside SvelteKit's
 * OWN Cloudflare worker, so an empty `url` base resolves `/_cirrus/rpc` against
 * the request origin via SvelteKit's `fetch` — a same-origin loopback, no second
 * worker and no CORS. Set `VITE_CIRRUS_URL` only if you split Cirrus out to a
 * standalone worker.
 */
export const load: PageLoad = async ({ fetch }) => {
    // "" → same-origin: `joinUrl("", "/_cirrus/rpc")` is `/_cirrus/rpc`, which
    // SvelteKit's `fetch` resolves against the request origin on the server.
    const url = import.meta.env.VITE_CIRRUS_URL ?? "";
    const client = createServerClient({ fetch, url });

    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded } as { preloaded: Preloaded<ReturnOf<typeof api.messages.list>> };
};
