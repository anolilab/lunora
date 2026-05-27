import { CirrusProvider, useMutation, useQuery } from "@cirrus/react";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

const channelId = "channel:demo" as const;

const Chat = () => {
    const data = useQuery("messages:list", { channelId });
    const send = useMutation("messages:send");
    const [draft, setDraft] = useState("");

    return (
        <div style={{ fontFamily: "system-ui", padding: 24 }}>
            <h1>{"{{name}}"}</h1>
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
};

const root = document.querySelector("#root");

if (root) {
    createRoot(root).render(
        <StrictMode>
            <CirrusProvider url="http://localhost:8787">
                <Chat />
            </CirrusProvider>
        </StrictMode>,
    );
}
