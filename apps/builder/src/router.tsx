import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * Router factory — exported as `getRouter` (the TanStack Start v1.168+
 * convention). TanStack Start's build tooling (`#tanstack-router-entry` /
 * hydrateStart.js) expects this exact export name. Called on both the client and
 * the server entry.
 */
// Return type deliberately INFERRED, not annotated: the `Register` interface
// below keys router typing off `ReturnType<typeof getRouter>`, so annotating it
// as the generic `ReturnType<typeof createTanStackRouter>` widens every route's
// params and context to `any` — type-safe routing silently stops being typed.
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- see above
export const getRouter = () => {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                // Lunora pushes data over WS, so a long stale time keeps
                // TanStack Query from racing the live subscription.
                staleTime: Number.POSITIVE_INFINITY,
            },
        },
    });

    return createTanStackRouter({
        context: { queryClient },
        defaultPreload: "intent",
        routeTree,
    });
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
