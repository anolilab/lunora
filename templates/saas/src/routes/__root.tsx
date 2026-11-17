import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { useState } from "react";

import { ImpersonationBanner } from "../../lunora/saas-ui/react";
import { authClient } from "../auth-client";

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
// Worker; under `vite dev`, `vite.config.ts` defines it for the server render
// only (as the dev server's origin), because `lunora/server.ts` serves Lunora
// from this same worker. The browser — in dev and in a production build alike —
// uses its page origin, so a remote dev box or tunnel still reaches the app. The
// server-side literal is a last resort; `import.meta.env.SSR` is what keeps it
// out of the client bundle.
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (import.meta.env.SSR ? "http://localhost:5173" : globalThis.location.origin);

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
                        <Impersonation />
                        <Outlet />
                    </LunoraProvider>
                </QueryClientProvider>
                <Scripts />
            </body>
        </html>
    );
}

/**
 * Whose session an admin is in, on every page — the admin screen itself refuses
 * the impersonated user, so it cannot hold the way back. A full load after the
 * swap, not a router navigation: every live query and cached result belongs to
 * the other user.
 */
function Impersonation() {
    const { data: session } = authClient.useSession();

    return (
        <ImpersonationBanner
            client={authClient.admin}
            onSessionChange={() => {
                globalThis.location.assign("/admin");
            }}
            session={session}
        />
    );
}
