import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const url = (import.meta.env.VITE_CIRRUS_URL as string | undefined) ?? "http://localhost:8787";
const client = new CirrusClient({ url });

const root = document.querySelector("#root");

if (!root) {
    throw new Error("missing #root mount node");
}

createRoot(root).render(
    <StrictMode>
        <CirrusProvider client={client}>
            <App />
        </CirrusProvider>
    </StrictMode>,
);
