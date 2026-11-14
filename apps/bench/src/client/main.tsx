import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// `@cloudflare/vite-plugin` serves the Worker on the same origin as Vite.
const client = new LunoraClient({ url: globalThis.location.origin });
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
