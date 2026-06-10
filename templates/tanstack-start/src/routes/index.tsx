import type { Preloaded, ReturnOf } from "@cirrus/client";
import { useMutation, usePreloadedQuery } from "@cirrus/react";
import { createServerClient, preloadQuery } from "@cirrus/react/server";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start/server";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api";

const channelId = "channel:demo" as const;

/**
 * SSR loader: runs on the server (Cloudflare Worker) before the route
 * renders. Builds a request-scoped `CirrusClient` that uses the HTTP RPC
 * path (/_cirrus/rpc) — no WebSocket, no in-process Durable Object access.
 *
 * Identity / session forwarding (PLAN4 open question #2):
 * Using the same-origin cookie path: we pass a `fetch` that forwards the
 * incoming `Cookie` header. TanStack Start exposes the raw Request through
 * `createServerFn` — we read `cookie` from the request headers and relay
 * it on every outgoing RPC call so the worker-side auth middleware sees the
 * same session the browser has. This keeps SSR and client on the same
 * identity without a separate bearer-token exchange.
 *
 * In-process vs network (PLAN4 open question #3):
 * M0 deliberately uses the HTTP path. The worker and the SSR renderer share
 * the same process in Cloudflare's module-worker model, so this is a
 * loopback call — low latency, but still a network round-trip through the
 * full Worker request handler. Whether an in-process `createCaller` bypass
 * is needed depends on measured latency in M1 load tests; it is NOT needed
 * for M0 correctness.
 */
const loadMessages = createServerFn().handler(async ({ request }) => {
    // Forward the browser's Cookie header so the CirrusClient's HTTP RPC
    // calls carry the same session cookie the client would send. This is the
    // identity-continuity answer for PLAN4 open question #2: same-origin
    // same-session, zero token-exchange overhead.
    const cookie = request.headers.get("cookie") ?? undefined;

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers((init as RequestInit | undefined)?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...(init as RequestInit | undefined), headers });
    };

    // Worker URL: in Cloudflare's module-worker SSR the worker and the SSR
    // renderer share the same process, so loopback to localhost works.
    // The env var lets operators point at a remote worker in preview deploys.
    const workerUrl =
        typeof process !== "undefined"
            ? (process.env["CIRRUS_WORKER_URL"] ?? "http://localhost:8787")
            : "http://localhost:8787";

    const client = createServerClient({ fetch: cookieForwardingFetch, url: workerUrl });

    // Sharded preload (PLAN4 open question #6): `channelId` is the shard key
    // because the schema declares `.shardBy("channelId")` on the messages
    // table. Passing it here routes the HTTP RPC to the correct Durable Object
    // shard without a shard-key resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded } as { preloaded: Preloaded<ReturnOf<typeof api.messages.list>> };
});

export const Route = createFileRoute("/")({
    // The loader runs server-side and returns the preloaded token. TanStack
    // Start embeds the serialized loader result in the SSR HTML and sends it
    // to the client, where `useLoaderData()` deserializes it without a
    // second network call.
    loader: () => loadMessages(),
    component: HomePage,
});

function HomePage() {
    // Read the preloaded token from the loader. On the server this is the
    // direct loader return value; on the client it is deserialized from the
    // dehydrated router state embedded in the SSR HTML.
    const { preloaded } = Route.useLoaderData();

    // `usePreloadedQuery` seeds TanStack Query's cache with the SSR value as
    // `initialData` — no loading flash, no hydration mismatch. After mount it
    // calls `getSubscriptionRegistry(client).attach(...)` to open the WS, so
    // subsequent server pushes update the data live (PLAN4 open question #1).
    const data = usePreloadedQuery(preloaded);

    const send = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <div style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
            <p>TanStack Start + Cirrus realtime queries.</p>
            <pre>{JSON.stringify(data, undefined, 2)}</pre>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    send.mutate({ channelId, text: draft });
                    setDraft("");
                }}
            >
                <input onChange={(event) => setDraft(event.target.value)} placeholder="Say something" value={draft} />
                <button type="submit">Send</button>
            </form>
        </div>
    );
}
