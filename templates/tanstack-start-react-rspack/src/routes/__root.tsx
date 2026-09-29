import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestUrl } from "@tanstack/react-start/server";
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

// Lunora endpoint. `PUBLIC_LUNORA_URL` wins so you can point at a deployed
// Worker. Otherwise it is the origin this page was served from, on both sides:
// the browser reads `location`, and a server render reads the request it is
// answering. That origin serves `/_lunora/*` in both modes — `rsbuild dev`
// proxies it to the Worker, and in production one Worker serves everything.
const lunoraOrigin = createIsomorphicFn()
    .server(() => getRequestUrl().origin)
    .client(() => globalThis.location.origin);

function RootComponent() {
    const { queryClient } = Route.useRouteContext();

    // Built per render tree, NOT at module scope: on the server a module-level
    // client is shared by every concurrent request, so one visitor's cached
    // results — and eventually their identity — leak into the next render.
    const [lunoraClient] = useState(() => new LunoraClient({ url: import.meta.env.PUBLIC_LUNORA_URL ?? lunoraOrigin() }));

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
