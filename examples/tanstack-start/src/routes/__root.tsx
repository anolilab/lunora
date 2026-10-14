import { LunoraProvider } from "@lunora/react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts, useRouteContext } from "@tanstack/react-router";
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

const RootComponent = (): React.ReactElement => {
    // `useRouteContext({ from })` rather than `Route.useRouteContext()`: `Route`
    // names this component in its `component:` option, so reaching back through
    // `Route` here makes the two declarations mutually referential.
    const { lunora, queryClient } = useRouteContext({ from: "__root__" });

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
};

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
    head: () => {
        return {
            links: [{ href: appCss, rel: "stylesheet" }],
            meta: [{ charSet: "utf8" }, { content: "width=device-width, initial-scale=1", name: "viewport" }, { title: "Lunora + TanStack Start" }],
        };
    },
});

/**
 * Both providers take the objects the router already built, so the client the
 * loaders queried with is the same one the components subscribe through — and
 * the TanStack cache the loader filled is the cache `useQuery` reads. That
 * sharing is what makes the server-rendered markup survive hydration without a
 * second fetch.
 */
