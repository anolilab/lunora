import "./styles.css";

import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// `@cloudflare/vite-plugin` serves the control-plane Worker on the same origin
// as Vite, so default to `location.origin` rather than a separate workerd port.
const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

const root = document.querySelector("#root");

if (!root) {
    throw new Error("missing #root mount node");
}

createRoot(root).render(
    <StrictMode>
        <LunoraProvider client={client}>
            <App />
        </LunoraProvider>
    </StrictMode>,
);
