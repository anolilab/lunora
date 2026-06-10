import type { Preloaded, ReturnOf } from "@cirrus/client";
import { useMutation, usePreloadedQuery } from "@cirrus/react";
import { createServerClient, preloadQuery } from "@cirrus/react/server";
import { useState } from "react";

import { api } from "../../cirrus/_generated/api";
import type { Route } from "./+types/home";

const channelId = "channel:demo" as const;

/**
 * SSR loader: runs on the server (the Cloudflare Worker) before the route
 * renders. React Router v7 hands the loader the raw Web `Request`, so the
 * identity-forwarding pattern is identical to the TanStack Start template
 * (M0-LIVE-LOADER-FINDINGS §4d): build a request-scoped `CirrusClient` whose
 * `fetch` relays the incoming `Cookie` header, so every HTTP RPC the SSR client
 * makes to `/_cirrus/rpc` runs as the same authenticated user the browser is.
 *
 * In-process vs network (PLAN4 open question #3): this uses the HTTP RPC path.
 * The worker and the SSR renderer share the same process in Cloudflare's
 * module-worker model, so it is a low-latency loopback. An in-process
 * `createCaller` bypass is a later optimisation, not a correctness requirement.
 */
export async function loader({ request }: Route.LoaderArgs) {
    // Forward the browser's Cookie header so the CirrusClient's HTTP RPC calls
    // carry the same session cookie the client would send (PLAN4 open question #2:
    // same-origin same-session, zero token-exchange overhead).
    const cookie = request.headers.get("cookie") ?? undefined;

    const cookieForwardingFetch: typeof fetch = (input, init) => {
        const headers = new Headers((init as RequestInit | undefined)?.headers);

        if (cookie) {
            headers.set("cookie", cookie);
        }

        return fetch(input, { ...(init as RequestInit | undefined), headers });
    };

    // Worker URL: in Cloudflare's module-worker SSR the worker and the SSR
    // renderer share the same process, so loopback to localhost works. An env
    // var lets operators point at a remote worker in preview deploys.
    const workerUrl = typeof process !== "undefined" ? (process.env["CIRRUS_WORKER_URL"] ?? "http://localhost:8787") : "http://localhost:8787";

    const client = createServerClient({ fetch: cookieForwardingFetch, url: workerUrl });

    // Sharded preload (PLAN4 open question #6): `channelId` is the shard key
    // because the schema declares `.shardBy("channelId")`. Passing it routes the
    // HTTP RPC to the correct Durable Object shard without a resolution round-trip.
    const preloaded = await preloadQuery(client, api.messages.list, { channelId }, { shardKey: channelId });

    return { preloaded } as { preloaded: Preloaded<ReturnOf<typeof api.messages.list>> };
}

export default function Home({ loaderData }: Route.ComponentProps) {
    // The serialized `Preloaded` token arrives in the SSR HTML and is the loader
    // data on the client too — no second network call.
    const { preloaded } = loaderData;

    // `usePreloadedQuery` seeds TanStack Query's cache with the SSR value as
    // `initialData` — no loading flash, no hydration mismatch. After mount it
    // opens the WS subscription, so subsequent server pushes update the data live
    // (PLAN4 open question #1).
    const data = usePreloadedQuery(preloaded);

    const send = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <div style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
            <p>React Router v7 + Cirrus live loaders.</p>
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
