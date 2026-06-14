import "./styles.css";

import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// `@cloudflare/vite-plugin` serves the control-plane Worker on the same origin
// as Vite, so default to `location.origin` rather than a separate workerd port.
const url = (import.meta.env.VITE_CIRRUS_URL as string | undefined) ?? globalThis.location.origin;
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
