import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState } from "react";

interface RouterContext {
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    head: () => ({
        meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }, { title: "{{name}}" }],
    }),
    component: RootComponent,
    notFoundComponent: () => (
        <main style={{ fontFamily: "system-ui", padding: "3rem", textAlign: "center" }}>
            <h1>404</h1>
            <p>This page could not be found.</p>
            <a href="/">Go home</a>
        </main>
    ),
});

// Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed
// Worker; `vite.config.ts` otherwise defines it as the dev server's resolved
// origin, because `virtual:lunora/worker` serves Lunora from this same worker.
// The literal below is only a last resort if that plugin is removed.
const isServer = typeof globalThis.window === "undefined";
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (isServer ? "http://localhost:5173" : globalThis.location.origin);

function RootComponent() {
    const { queryClient } = Route.useRouteContext();

    // Built per render tree, NOT at module scope: on the server a module-level
    // client is shared by every concurrent request, so one visitor's cached
    // results — and eventually their identity — leak into the next render.
    const [lunoraClient] = useState(() => new LunoraClient({ url: lunoraUrl }));

    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <LunoraProvider client={lunoraClient}>
                        <Outlet />
                    </LunoraProvider>
                </QueryClientProvider>
                <Scripts />
            </body>
        </html>
    );
}
