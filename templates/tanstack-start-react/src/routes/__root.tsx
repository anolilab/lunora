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
});

function RootComponent() {
    const { queryClient } = Route.useRouteContext();

    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <LunoraProvider url={typeof window === "undefined" ? "http://localhost:8787" : window.location.origin}>
                        <Outlet />
                    </LunoraProvider>
                </QueryClientProvider>
                <Scripts />
            </body>
        </html>
    );
}
