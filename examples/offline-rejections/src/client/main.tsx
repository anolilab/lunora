import { LunoraProvider } from "@lunora/react";
import { createIndexedDbPersistence, LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;

// `persistence` is the load-bearing option for this demo: queued writes are
// mirrored to IndexedDB, so a write made offline survives a page reload. After a
// reload the original `mutation()` Promise is gone, so a rejected replay can
// ONLY be surfaced via `client.onMutationSettled` (with `hadAwaiter: false`) —
// which is exactly what `App` wires up.
const client = new LunoraClient({ url, persistence: createIndexedDbPersistence() });

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
