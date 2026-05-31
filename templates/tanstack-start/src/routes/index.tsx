import { useMutation, useQuery } from "@cirrus/react";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

const channelId = "channel:demo" as const;

export const Route = createFileRoute("/")({
    component: HomePage,
});

function HomePage() {
    const data = useQuery("messages:list", { channelId });
    const send = useMutation("messages:send");
    const [draft, setDraft] = useState("");

    return (
        <div style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
            <p>TanStack Start + Cirrus realtime queries.</p>
            <pre>{JSON.stringify(data, undefined, 2)}</pre>
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    send({ channelId, text: draft });
                    setDraft("");
                }}
            >
                <input onChange={(event) => setDraft(event.target.value)} placeholder="Say something" value={draft} />
                <button type="submit">Send</button>
            </form>
        </div>
    );
}
