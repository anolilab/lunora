import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * Router factory — exported as `getRouter` (the TanStack Start v1.168+ convention).
 * TanStack Start's build tooling (`#tanstack-router-entry` / hydrateStart.js)
 * expects this exact export name. Called on both the client and the server entry.
 */
export const getRouter = () => {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                // Cirrus pushes data over WS, so a long stale time keeps
                // TanStack Query from racing the live subscription.
                staleTime: Number.POSITIVE_INFINITY,
            },
        },
    });

    const router = createTanStackRouter({
        routeTree,
        context: { queryClient },
        defaultPreload: "intent",
    });

    return router;
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
