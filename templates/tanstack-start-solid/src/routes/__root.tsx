import { CirrusClient } from "@cirrus/client";
import { CirrusProvider } from "@cirrus/solid";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import { Suspense } from "solid-js";
import { HydrationScript } from "solid-js/web";

/**
 * One CirrusClient per app, constructed at module scope. The constructor opens
 * no socket — connections are established on the first `createQuery` /
 * `hydratePreloaded` subscription, and those effects only run on the client —
 * so a single shared instance is SSR-safe. On the server `window` is undefined,
 * so we fall back to the loopback worker origin; the browser uses the page origin.
 */
const cirrusClient = new CirrusClient({
    url: typeof window === "undefined" ? "http://localhost:8787" : window.location.origin,
});

export const Route = createRootRouteWithContext()({
    head: () => ({
        meta: [{ charset: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "{{name}}" }],
    }),
    shellComponent: RootComponent,
});

function RootComponent() {
    return (
        <html lang="en">
            <head>
                <HydrationScript />
                <HeadContent />
            </head>
            <body>
                <CirrusProvider client={cirrusClient}>
                    <Suspense>
                        <Outlet />
                    </Suspense>
                </CirrusProvider>
                <Scripts />
            </body>
        </html>
    );
}
