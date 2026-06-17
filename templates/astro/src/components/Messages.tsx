import { LunoraClient } from "lunora/client";
import type { Preloaded } from "@lunora/react";
import { LunoraProvider, hydratePreloaded, useMutation } from "@lunora/react";
import { useMemo, useState } from "react";

import { api } from "../../lunora/_generated/api";

type MessagesResult = Preloaded<{ channelId: string; limit: number; messages: { _id: string; text: string }[] }>;

const channelId = "channel:demo";

/**
 * The live half of the reactive-loader handoff. `hydratePreloaded(preloaded)`
 * seeds from the SSR snapshot synchronously (no loading flash, no refetch), then
 * opens the WebSocket subscription so the list re-renders on every server write.
 *
 * This island is hydrated with `client:load` from `index.astro`. The reactivity
 * is React's (this is a `@lunora/react` island) — Astro itself stays
 * framework-neutral; swap this for a `@lunora/solid` / `@lunora/svelte` /
 * `@lunora/vue` island and the server half (`index.astro`) is unchanged.
 */
const MessageList = ({ preloaded }: { preloaded: MessagesResult }): React.ReactElement => {
    const data = hydratePreloaded(preloaded);
    const send = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <section>
            <ul>
                {data.messages.map((message) => (
                    <li key={message._id}>{message.text}</li>
                ))}
            </ul>
            <form
                onSubmit={(event) => {
                    event.preventDefault();

                    if (draft.trim().length === 0) {
                        return;
                    }

                    void send({ channelId, text: draft });
                    setDraft("");
                }}
            >
                <input onChange={(event) => setDraft(event.target.value)} placeholder="Say something…" value={draft} />
                <button type="submit">Send</button>
            </form>
        </section>
    );
};

/**
 * Island entry: build the browser `LunoraClient` (it opens the WebSocket lazily
 * on the first subscription) and provide it. The client talks to the SAME origin
 * the page was served from, so `/_lunora/ws` loops back into this app's composed
 * worker and resumes the cookie-based session SSR used — no separate worker.
 */
const Messages = ({ preloaded }: { preloaded: MessagesResult }): React.ReactElement => {
    const client = useMemo(() => new LunoraClient({ url: globalThis.location.origin }), []);

    return (
        <LunoraProvider client={client}>
            <MessageList preloaded={preloaded} />
        </LunoraProvider>
    );
};

export default Messages;
