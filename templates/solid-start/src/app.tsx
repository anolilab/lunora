import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/solid";
import { Router } from "@solidjs/router";
import { FileRoutes } from "@solidjs/start/router";
import { Suspense } from "solid-js";
import { isServer } from "solid-js/web";

/**
 * The Cirrus transport. On the client it points at the current origin (the same
 * worker that served the page); during SSR it points at the loopback worker URL.
 * Built once at module scope so the same instance — and its single WebSocket —
 * survives client-side navigations.
 */
const client = new CirrusClient({
    url: isServer ? (process.env.CIRRUS_WORKER_URL ?? "http://localhost:8787") : window.location.origin,
});

/**
 * Root component. Wraps the router in `<CirrusProvider>` so every route's
 * `createQuery` / `createMutation` / `hydratePreloaded` reads the shared client
 * from context.
 */
export default function App() {
    return (
        <Router
            root={(props) => (
                <CirrusProvider client={client}>
                    <Suspense>{props.children}</Suspense>
                </CirrusProvider>
            )}
        >
            <FileRoutes />
        </Router>
    );
}
