import type { Preloaded, ReturnOf } from "@cirrus/client";
import { useMutation, usePreloadedQuery } from "@cirrus/react";
import { createServerClient, preloadQuery } from "@cirrus/react/server";
import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api";

const channelId = "channel:demo" as const;

/**
 * SSR loader: runs on the server (Cloudflare Worker) before the route renders.
 * Builds a request-scoped CirrusClient that uses the HTTP RPC path (/_cirrus/rpc).
 *
 * `createServerFn` is imported from "@tanstack/react-start" (the allowed client-safe
 * entry). The handler closure is tree-shaken away from the client bundle — only a
 * lightweight RPC stub remains on the client side. Importing the helper from the
 * sub-path "@tanstack/react-start/server" is NOT needed here and must be avoided:
 * TanStack Start's import-protection plugin marks that sub-path as client-denied,
 * and with Vite 8 + rolldown the resulting mock-edge virtual modules cannot be
 * resolved (UNLOADABLE_DEPENDENCY). Use createServerFn from the main entry instead.
 *
 * Cookie forwarding: if your app needs to forward the incoming Cookie header to
 * Cirrus RPC calls for session continuity, use createMiddleware() from
 * "@tanstack/react-start" and call getRequestHeader("cookie") inside the middleware
 * handler — middleware files that import "@tanstack/react-start/server" should live
 * in a dedicated *.server.ts file so the import-protection file rule (not the
 * specifier rule) applies, and TanStack Start generates a safe empty-exports mock
 * instead of the problematic mock-edge virtual modules.
 *
 * In-process vs network: the worker and the SSR renderer share the same process
 * in Cloudflare's module-worker model, so this is a loopback call — low latency.
 */
const loadMessages = createServerFn().handler(async () => {
    // Worker URL: in Cloudflare's module-worker SSR the worker and SSR renderer share
    // the same process, so loopback to localhost works. The env var lets operators
    // point at a remote worker in preview deploys.
    const workerUrl =
        typeof process !== "undefined"
            ? (process.env["CIRRUS_WORKER_URL"] ?? "http://localhost:8787")
            : "http://localhost:8787";

    const client = createServerClient({ url: workerUrl });

    // Sharded preload: `channelId` is the shard key because the schema declares
    // `.shardBy("channelId")` on the messages table.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded } as { preloaded: Preloaded<ReturnOf<typeof api.messages.list>> };
});

export const Route = createFileRoute("/")({
    // The loader runs server-side and returns the preloaded token. TanStack Start
    // embeds the serialized loader result in the SSR HTML and sends it to the client,
    // where `useLoaderData()` deserializes it without a second network call.
    loader: () => loadMessages(),
    component: HomePage,
});

function HomePage() {
    // Read the preloaded token from the loader. On the server this is the direct
    // loader return value; on the client it is deserialized from the dehydrated router
    // state embedded in the SSR HTML.
    const { preloaded } = Route.useLoaderData();

    // `usePreloadedQuery` seeds TanStack Query's cache with the SSR value as
    // `initialData` — no loading flash, no hydration mismatch. After mount it opens
    // a WebSocket subscription so subsequent server pushes update the data live.
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
