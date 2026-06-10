import { createMutation, hydratePreloaded } from "@cirrus/solid";
import type { Preloaded, ReturnOf } from "@cirrus/solid/server";
import { createServerClient, preloadQuery } from "@cirrus/solid/server";
import { createAsync, query } from "@solidjs/router";
import { getRequestEvent } from "solid-js/web";
import { createSignal, Show } from "solid-js";

import { api } from "../../cirrus/_generated/api";

const channelId = "channel:demo" as const;

type MessagesResult = ReturnOf<typeof api.messages.list>;

/**
 * SSR loader: a SolidStart `query` marked `"use server"` runs only on the server
 * (the Cloudflare Worker) before the route renders. It builds a request-scoped
 * `CirrusClient` that uses the HTTP RPC path (`/_cirrus/rpc`) — no WebSocket, no
 * in-process Durable Object access — and returns a serializable `Preloaded`
 * token. `createServerClient` (from `@cirrus/solid/server`, a re-export of the
 * framework-neutral `@cirrus/ssr` contract) builds that request-scoped client.
 *
 * Identity continuity (PLAN4 open question #2): same-origin cookie forwarding.
 * `getRequestEvent()` exposes the inbound request, so we relay its `Cookie`
 * header on every outgoing RPC. The worker-side auth middleware then sees the
 * same session the browser has — no separate bearer-token exchange.
 *
 * Sharded preload (PLAN4 open question #6): `channelId` is the shard key because
 * the schema declares `.shardBy("channelId")` on the messages table. Passing it
 * routes the RPC to the correct Durable Object shard.
 */
const loadMessages = query(async (): Promise<Preloaded<MessagesResult>> => {
    "use server";

    const event = getRequestEvent();
    const cookie = event?.request.headers.get("cookie") ?? undefined;

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers(init?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...init, headers });
    };

    // In Cloudflare's module-worker model the worker and the SSR renderer share
    // the same process, so loopback to localhost works; the env var lets
    // operators point at a remote worker in preview deploys.
    const workerUrl = process.env.CIRRUS_WORKER_URL ?? "http://localhost:8787";

    // `createServerClient` only opens a socket on `.subscribe()`/`.stream()`; the
    // loader only calls `preloadQuery` (HTTP RPC), so no live connection is made
    // server-side. Build a fresh one per request so each runs under its own
    // forwarded session.
    const client = createServerClient({ fetch: cookieForwardingFetch, url: workerUrl });

    return preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });
}, "messages");

export const route = {
    // Run the loader server-side during SSR; SolidStart serializes the resolved
    // `Preloaded` token into the HTML so the client hydrates with no extra fetch.
    preload: () => loadMessages(),
};

export default function HomePage() {
    // `createAsync` reads the loader result. During hydration it resolves
    // synchronously from the serialized SSR value (the loader already ran), so
    // there is no client-side refetch.
    const preloaded = createAsync(() => loadMessages());

    const send = createMutation(api.messages.send);
    const [draft, setDraft] = createSignal("");

    return (
        <main style={{ "font-family": "system-ui", padding: "24px" }}>
            <h1>{"{{name}}"}</h1>
            <p>SolidStart + Cirrus live loaders.</p>

            <Show when={preloaded()} fallback={<p>Loading…</p>}>
                {(token) => {
                    // `hydratePreloaded` seeds synchronously from the SSR token
                    // (no loading flash), then attaches the live WS subscription —
                    // PLAN4's "your loaders are live" handoff.
                    const data = hydratePreloaded(token());

                    return <pre>{JSON.stringify(data(), undefined, 2)}</pre>;
                }}
            </Show>

            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void send.mutate({ channelId, text: draft() });
                    setDraft("");
                }}
            >
                <input onInput={(event) => setDraft(event.currentTarget.value)} placeholder="Say something" value={draft()} />
                <button type="submit" disabled={send.pending()}>
                    Send
                </button>
            </form>
        </main>
    );
}
