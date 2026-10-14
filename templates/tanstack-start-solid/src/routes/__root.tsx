import { LunoraClient } from "lunorash/client";
import { LunoraProvider } from "@lunora/solid";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/solid-router";
import { Suspense } from "solid-js";
import { HydrationScript } from "solid-js/web";

// Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed
// Worker; under `vite dev`, `vite.config.ts` defines it as the dev server's
// resolved origin, because the composed `virtual:lunora/worker` entry serves
// Lunora from this same worker. A production build leaves it unset, so the
// browser uses its page origin. The server-side literal is a last resort;
// `import.meta.env.SSR` is what keeps it out of the client bundle.
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (import.meta.env.SSR ? "http://localhost:5173" : globalThis.location.origin);

export const Route = createRootRouteWithContext()({
    head: () => ({
        meta: [{ charset: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "{{name}}" }],
    }),
    shellComponent: RootComponent,
    notFoundComponent: () => (
        <main style={{ "font-family": "system-ui", padding: "3rem", "text-align": "center" }}>
            <h1>404</h1>
            <p>This page could not be found.</p>
            <a href="/">Go home</a>
        </main>
    ),
});

function RootComponent() {
    // Built per render tree, NOT at module scope: on the server a module-level
    // client is shared by every concurrent request, so one visitor's cached
    // results — and eventually their identity — leak into the next render.
    const lunoraClient = new LunoraClient({ url: lunoraUrl });

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
