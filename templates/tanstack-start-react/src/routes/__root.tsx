import { LunoraProvider } from "@lunora/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";

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

// Lunora endpoint. `VITE_LUNORA_URL` (statically replaced by Vite at dev/build)
// wins so you can point at a deployed Worker; otherwise the browser uses the
// page origin and SSR loops back to the local dev worker.
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (typeof window === "undefined" ? "http://localhost:8787" : window.location.origin);

function RootComponent() {
    const { queryClient } = Route.useRouteContext();

    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <LunoraProvider url={lunoraUrl}>
                        <Outlet />
                    </LunoraProvider>
                </QueryClientProvider>
                <Scripts />
            </body>
        </html>
    );
}
