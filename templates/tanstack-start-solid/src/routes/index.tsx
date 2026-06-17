import type { Preloaded, ReturnOf } from "lunora/client";
import { createMutation, hydratePreloaded } from "@lunora/solid";
import { createServerClient, preloadQuery } from "@lunora/solid/server";
import { createFileRoute } from "@tanstack/solid-router";
import { createServerFn } from "@tanstack/solid-start";
import { createSignal } from "solid-js";

import { api } from "../../lunora/_generated/api";

const channelId = "channel:demo" as const;

/**
 * SSR loader: runs on the server (Cloudflare Worker) before the route renders.
 * Builds a request-scoped LunoraClient that uses the HTTP RPC path (/_lunora/rpc).
 *
 * `createServerFn` is imported from "@tanstack/solid-start" (the client-safe
 * entry). The handler closure is tree-shaken away from the client bundle — only
 * a lightweight RPC stub remains on the client side.
 *
 * In-process vs network: the worker and the SSR renderer share the same process
 * in Cloudflare's module-worker model, so this is a loopback call — low latency.
 */
const loadMessages = createServerFn().handler(async () => {
    // Worker URL: in Cloudflare's module-worker SSR the worker and SSR renderer share
    // the same process, so loopback to localhost works. The env var lets operators
    // point at a remote worker in preview deploys.
    const workerUrl = typeof process !== "undefined" ? (process.env["LUNORA_WORKER_URL"] ?? "http://localhost:8787") : "http://localhost:8787";

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
    // `useLoaderData()` returns a Solid accessor; on the server it is the loader's
    // direct return value, on the client it is deserialized from the dehydrated
    // router state embedded in the SSR HTML.
    const loaderData = Route.useLoaderData();

    // `hydratePreloaded` seeds a signal synchronously from the SSR value (no
    // loading flash, no hydration mismatch), then opens a WebSocket subscription
    // after mount so subsequent server pushes update the data live.
    const data = hydratePreloaded(loaderData().preloaded);

    const send = createMutation(api.messages.send);
    const [draft, setDraft] = createSignal("");

    return (
        <div style={{ "font-family": "system-ui", padding: "24px" }}>
            <h1>{"{{name}}"}</h1>
            <p>TanStack Start (Solid) + Lunora realtime queries.</p>
            <pre>{JSON.stringify(data(), undefined, 2)}</pre>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void send.mutate({ channelId, text: draft() });
                    setDraft("");
                }}
            >
                <input onInput={(event) => setDraft(event.currentTarget.value)} placeholder="Say something" value={draft()} />
                <button type="submit">Send</button>
            </form>
        </div>
    );
}
