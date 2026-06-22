import { useMutation, useQuery } from "@lunora/react";
import { useState } from "react";

import { api } from "../../lunora/_generated/api";
import type { Route } from "./+types/home";

const channelId = "channel:demo" as const;

/**
 * Route-level <head> tags. React Router v7 framework mode collects these from the
 * `meta` export and renders them through the `<Meta />` slot in `app/root.tsx`.
 */
export function meta(_: Route.MetaArgs) {
    return [{ title: "{{name}}" }, { content: "React Router v7 + Lunora realtime queries.", name: "description" }];
}

export default function Home() {
    // `useQuery` opens a live WebSocket subscription: it returns `undefined` until
    // the first response lands, then updates in place on every server push.
    // `channelId` is the shard key because the schema declares `.shardBy("channelId")`.
    const data = useQuery(api.messages.list, { channelId }, { shardKey: channelId });

    const send = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <div style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
            <p>React Router v7 + Lunora realtime queries.</p>
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
