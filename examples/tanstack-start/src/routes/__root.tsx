import { LunoraProvider } from "@lunora/react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { LunoraClient } from "lunorash/client";

import appCss from "./app.css?url";

/**
 * Exported because the generated route tree names it in the types it emits —
 * a local interface here makes `routeTree.gen.ts` fail to compile (TS4023).
 */
export interface RouterContext {
    lunora: LunoraClient;
    queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
    head: () => ({
        links: [{ href: appCss, rel: "stylesheet" }],
        meta: [{ charSet: "utf-8" }, { content: "width=device-width, initial-scale=1", name: "viewport" }, { title: "Lunora + TanStack Start" }],
    }),
});

/**
 * Both providers take the objects the router already built, so the client the
 * loaders queried with is the same one the components subscribe through — and
 * the TanStack cache the loader filled is the cache `useQuery` reads. That
 * sharing is what makes the server-rendered markup survive hydration without a
 * second fetch.
 */
function RootComponent(): React.ReactElement {
    const { lunora, queryClient } = Route.useRouteContext();

    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <LunoraProvider client={lunora}>
                        <Outlet />
                    </LunoraProvider>
                </QueryClientProvider>
                <Scripts />
            </body>
        </html>
    );
}
