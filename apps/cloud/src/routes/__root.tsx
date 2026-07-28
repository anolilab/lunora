import { LunoraClient } from "@lunora/client";
import { LunoraProvider } from "@lunora/react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Link, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useState } from "react";

import appCss from "../client/styles.css?url";
import themeCss from "../client/theme.css?url";

interface RouterContext {
    queryClient: QueryClient;
}

const RootComponent = (): ReactElement => {
    const { queryClient } = Route.useRouteContext();
    // One client per mount. `useState` (not `useMemo`) so React can never discard
    // and rebuild it — a fresh client would drop every live subscription.
    const [client] = useState(() => new LunoraClient({ url: lunoraUrl }));

    return (
        <html lang="en">
            <head>
                <HeadContent />
            </head>
            <body>
                <QueryClientProvider client={queryClient}>
                    <LunoraProvider client={client}>
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
            links: [
                { href: themeCss, rel: "stylesheet" },
                { href: appCss, rel: "stylesheet" },
            ],
            meta: [{ charSet: "utf8" }, { content: "width=device-width, initial-scale=1", name: "viewport" }, { title: "Lunora Cloud" }],
        };
    },
    notFoundComponent: () => (
        <main className="content">
            <div className="callout">
                <h1>404</h1>
                <p>This page could not be found.</p>
                <Link className="link" to="/">
                    Back to organizations
                </Link>
            </div>
        </main>
    ),
});

/**
 * Lunora endpoint for the browser client. On the server the provider is only
 * rendered — the SSR data came from `src/ssr/loader.ts`, which speaks HTTP — so
 * the page origin is the right target in both environments. `VITE_LUNORA_URL`
 * overrides it for pointing a local studio at a deployed control plane.
 */
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (import.meta.env.SSR ? "/" : globalThis.location.origin);
