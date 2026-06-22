import "./App.css";

import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

import { api } from "../lunora/_generated/api.js";
import lunoraLogo from "./assets/lunora.svg";
import viteLogo from "/vite.svg";

const channelId = "channel:demo" as const;

/**
 * Vite + Lunora starter. The message list below is NOT React state — it lives in
 * a Durable Object and streams to every client over a WebSocket. Open a second
 * tab and watch it sync in real time.
 */
export const App = (): ReactElement => {
    const data = useQuery(api.messages.list, { channelId });
    const { mutate: send, pending } = useMutation(api.messages.send);
    const [draft, setDraft] = useState("");

    return (
        <>
            <div>
                <a href="https://vite.dev" rel="noreferrer" target="_blank">
                    <img alt="Vite logo" className="logo" src={viteLogo} />
                </a>
                <a href="https://lunora.sh" rel="noreferrer" target="_blank">
                    <img alt="Lunora logo" className="logo lunora" src={lunoraLogo} />
                </a>
            </div>
            <h1>Vite + Lunora</h1>
            <div className="card">
                <form
                    onSubmit={(event) => {
                        event.preventDefault();

                        if (draft) {
                            void send({ channelId, text: draft });
                            setDraft("");
                        }
                    }}
                >
                    <input onChange={(event) => setDraft(event.target.value)} placeholder="Say something" value={draft} />
                    <button disabled={pending} type="submit">
                        Send
                    </button>
                </form>
                <pre>{JSON.stringify(data ?? { messages: [] }, undefined, 2)}</pre>
                <p>
                    This list is <strong>live and shared</strong> — open a second tab and watch it sync.
                </p>
                <p>
                    Edit <code>src/App.tsx</code> for the UI or <code>lunora/messages.ts</code> for the backend, then save.
                </p>
            </div>
            <p className="read-the-docs">Click the Lunora logo to read the docs</p>
        </>
    );
};
