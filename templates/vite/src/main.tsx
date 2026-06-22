import "./index.css";

import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// `@lunora/vite` runs the Worker on the same origin as Vite, so default to
// `location.origin`. Point `VITE_LUNORA_URL` at a deployed Worker to develop
// the client against production data.
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
