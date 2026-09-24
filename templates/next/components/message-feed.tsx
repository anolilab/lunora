"use client";

import type { Preloaded, ReturnOf } from "lunorash/client";
import { useMutation, usePreloadedQuery } from "@lunora/react";
import { useState } from "react";

import { api } from "../lunora/_generated/api";

const channelId = "channel:demo" as const;

/**
 * Client component that receives the RSC-produced `Preloaded` token.
 * `usePreloadedQuery` seeds TanStack Query's cache with the server value — the
 * first render shows it with no loading flash and no hydration mismatch — then
 * attaches a live WebSocket subscription that updates `data` on every server
 * delta.
 */
export function MessageFeed({ preloaded }: { preloaded: Preloaded<ReturnOf<typeof api.messages.list>> }) {
    const data = usePreloadedQuery(preloaded);

    const { mutate, pending } = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <section>
            <pre>{JSON.stringify(data, undefined, 2)}</pre>
            <form
                onSubmit={(event) => {
                    event.preventDefault();

                    if (!draft) {
                        return;
                    }

                    // Same shard key the RSC preload reads from — the schema declares
                    // `.shardBy("channelId")`, so an unrouted write would land on the
                    // default shard and never appear in this feed.
                    void mutate({ channelId, text: draft }, { shardKey: channelId });
                    setDraft("");
                }}
            >
                <input onChange={(event) => setDraft(event.target.value)} placeholder="Say something" value={draft} />
                <button disabled={pending} type="submit">
                    Send
                </button>
            </form>
        </section>
    );
}
