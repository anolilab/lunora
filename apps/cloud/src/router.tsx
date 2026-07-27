import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

/**
 * Router factory. Must be exported as `getRouter` — TanStack Start's build
 * tooling (`#tanstack-router-entry` / `hydrateStart`) resolves that exact name,
 * and it is called on both the client and the SSR entry.
 */
// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types -- the return type MUST stay inferred: `declare module "@tanstack/react-router"` below registers `ReturnType<typeof getRouter>` as the app's router, which is what types every `Route.useParams()` / `useLoaderData()` / `Link to=`. Annotating it (even as `AnyRouter`) erases the route tree and degrades every consumer to `any`.
export const getRouter = () => {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                // Lunora pushes updates over the WebSocket, so nothing here should
                // re-fetch on its own: an infinite stale time keeps TanStack Query
                // from racing the live subscription that owns each key after mount.
                staleTime: Number.POSITIVE_INFINITY,
            },
        },
    });

    return createTanStackRouter({
        context: { queryClient },
        defaultPreload: "intent",
        routeTree,
        // The dashboard is session-gated per route, so a stale preloaded loader
        // result must not outlive a sign-out.
        defaultPreloadStaleTime: 0,
    });
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
