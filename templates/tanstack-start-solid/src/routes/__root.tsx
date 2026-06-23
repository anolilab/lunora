import { LunoraClient } from "lunorash/client";
import { LunoraProvider } from "@lunora/solid";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import { Suspense } from "solid-js";
import { HydrationScript } from "solid-js/web";

/**
 * One LunoraClient per app, constructed at module scope. The constructor opens
 * no socket — connections are established on the first `createQuery` /
 * `hydratePreloaded` subscription, and those effects only run on the client —
 * so a single shared instance is SSR-safe. On the server `window` is undefined,
 * so we fall back to the loopback worker origin; the browser uses the page origin.
 */
const lunoraClient = new LunoraClient({
    // `VITE_LUNORA_URL` (statically replaced by Vite at dev/build) wins so you can
    // point at a deployed Worker; otherwise the browser uses the page origin and
    // SSR loops back to the local dev worker.
    url: (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (typeof window === "undefined" ? "http://localhost:8787" : window.location.origin),
});

export const Route = createRootRouteWithContext()({
    head: () => ({
        meta: [{ charset: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "{{name}}" }],
    }),
    shellComponent: RootComponent,
    notFoundComponent: () => (
        <main style={{ fontFamily: "system-ui", padding: "3rem", textAlign: "center" }}>
            <h1>404</h1>
            <p>This page could not be found.</p>
            <a href="/">Go home</a>
        </main>
    ),
});

function RootComponent() {
    return (
        <html lang="en">
            <head>
                <HydrationScript />
                <HeadContent />
            </head>
            <body>
                <LunoraProvider client={lunoraClient}>
                    <Suspense>
                        <Outlet />
                    </Suspense>
                </LunoraProvider>
                <Scripts />
            </body>
        </html>
    );
}
