import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";

// `rsbuild dev` proxies `/_lunora/*` to the Worker, and in production the same
// Worker serves this SPA, so default to `location.origin`. Point
// `PUBLIC_LUNORA_URL` at a deployed Worker to develop the client against
// production data.
const client = new LunoraClient({ url: import.meta.env.PUBLIC_LUNORA_URL ?? globalThis.location.origin });

const root = document.getElementById("root");

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
