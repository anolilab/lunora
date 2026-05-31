import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * Centralised router factory. TanStack Start calls this on both the client
 * and the server entry, so anything that needs to be shared (query client,
 * cirrus client) lives here.
 */
export const createRouter = () => {
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
        router: ReturnType<typeof createRouter>;
    }
}
