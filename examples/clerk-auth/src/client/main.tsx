import { ClerkProvider } from "@clerk/react";
import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { ClerkTokenBridge } from "./clerk-token-bridge.js";

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

if (!publishableKey) {
    throw new Error("Set VITE_CLERK_PUBLISHABLE_KEY in .env.local (see README.md)");
}

// `authTokenOnUpgrade` makes the live-query sockets present the Clerk token too:
// a browser cannot set `Authorization` on a WebSocket, so the client offers it as
// a `Sec-WebSocket-Protocol` entry, never in the URL.
const client = new LunoraClient({
    authTokenOnUpgrade: true,
    url: (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin,
});

const root = document.querySelector("#root");

if (!root) {
    throw new Error("missing #root mount node");
}

createRoot(root).render(
    <StrictMode>
        <ClerkProvider publishableKey={publishableKey}>
            <ClerkTokenBridge client={client}>
                <LunoraProvider client={client}>
                    <App />
                </LunoraProvider>
            </ClerkTokenBridge>
        </ClerkProvider>
    </StrictMode>,
);
