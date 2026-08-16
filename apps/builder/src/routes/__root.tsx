import "./app.css";

import { LunoraProvider } from "@lunora/react";
import type { QueryClient } from "@tanstack/react-query";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { LunoraClient } from "lunorash/client";
import type { JSX } from "react";
import { useState } from "react";

interface RouterContext {
    queryClient: QueryClient;
}

/**
 * Lunora endpoint. `VITE_LUNORA_URL` wins so you can point at a deployed Worker;
 * `vite.config.ts` otherwise defines it as the dev server's resolved origin,
 * because `virtual:lunora/worker` serves Lunora from this same worker. The
 * literal below is only a last resort if that plugin is removed.
 *
 * `import.meta.env.SSR` rather than a `typeof window` probe: Vite resolves it at
 * build time per environment, so the client bundle never carries the server
 * branch. (It also survives `eslint --fix`, which rewrites a `typeof window ===
 * "undefined"` guard into a `window === undefined` comparison TypeScript then
 * correctly reports as always-false — a silent inversion of the guard.)
 */
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (import.meta.env.SSR ? "http://localhost:5173" : globalThis.location.origin);

const NotFound = (): JSX.Element => (
    <main className="empty">
        <h1>404</h1>
        <p>This page could not be found.</p>
        <a href="/">Go home</a>
    </main>
);

const RootComponent = (): JSX.Element => {
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
};

export const Route = createRootRouteWithContext<RouterContext>()({
    component: RootComponent,
    head: () => {
        return { meta: [{ charSet: "utf8" }, { content: "width=device-width, initial-scale=1", name: "viewport" }, { title: "Lander" }] };
    },
    notFoundComponent: NotFound,
});
