import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

// `@cloudflare/vite-plugin` serves the Worker on the same origin as this page, so the client uses that origin.
// The example does not support a frontend on another origin: sign-in and the Lunora calls would need trusted origins
// and credentialed CORS, which it does not configure.
const url = globalThis.location.origin;
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
