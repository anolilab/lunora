import { LunoraProvider } from "@lunora/react";
import { AuthKitProvider } from "@workos-inc/authkit-react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { WorkOsTokenBridge } from "./workos-token-bridge.js";

const clientId = import.meta.env.VITE_WORKOS_CLIENT_ID as string | undefined;
const apiHostname = import.meta.env.VITE_WORKOS_API_HOSTNAME as string | undefined;

if (!clientId) {
    throw new Error("Set VITE_WORKOS_CLIENT_ID in .env.local (see README.md)");
}

// `authTokenOnUpgrade` makes the live-query sockets present the access token too:
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
        <AuthKitProvider apiHostname={apiHostname} clientId={clientId}>
            <WorkOsTokenBridge client={client}>
                <LunoraProvider client={client}>
                    <App />
                </LunoraProvider>
            </WorkOsTokenBridge>
        </AuthKitProvider>
    </StrictMode>,
);
