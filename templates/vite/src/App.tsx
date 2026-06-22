import "./App.css";

import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";

import { api } from "../lunora/_generated/api.js";
import lunoraLogo from "./assets/lunora.svg";
import viteLogo from "/vite.svg";

/**
 * Vite + Lunora starter. The counter below is NOT React state — it lives in a
 * Durable Object and streams to every client over a WebSocket. Open a second
 * tab and watch it sync in real time.
 */
export const App = (): ReactElement => {
    const count = useQuery(api.counter.get, {});
    const { mutate: increment, pending } = useMutation(api.counter.increment);

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
                <button disabled={pending} onClick={() => void increment({})} type="button">
                    count is {count ?? 0}
                </button>
                <p>
                    This counter is <strong>live and shared</strong> — open a second tab and watch it sync.
                </p>
                <p>
                    Edit <code>src/App.tsx</code> for the UI or <code>lunora/counter.ts</code> for the backend, then save.
                </p>
            </div>
            <p className="read-the-docs">Click the Lunora logo to read the docs</p>
        </>
    );
};
