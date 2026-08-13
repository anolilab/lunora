import "./welcome.css";

import { LunoraProvider } from "@lunora/solid";
import { LunoraClient } from "lunorash/client";
import { render } from "@solidjs/web";

import App from "./App";

// `@lunora/vite` runs the Worker on the same origin as the dev server, so
// default to `location.origin`. Point `VITE_LUNORA_URL` at a deployed Worker to
// develop the client against production data.
const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;
const client = new LunoraClient({ url });

const root = document.getElementById("root");

if (!root) {
    throw new Error("missing #root mount node");
}

// `render` lives in `@solidjs/web` in Solid 2 — `solid-js/web` no longer exists.
render(
    () => (
        <LunoraProvider client={client}>
            <App />
        </LunoraProvider>
    ),
    root,
);
