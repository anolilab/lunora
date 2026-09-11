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
        // Long enough that the hover which triggered the preload actually gets to
        // use it. With the previous `defaultPreloadStaleTime: 0` every preloaded
        // match was stale on arrival, so hovering the 19-tab bar fired a
        // server-function round trip per tab and discarded all of them. Session
        // freshness is not a factor here — the gate is `_authed`'s `beforeLoad`,
        // not loader data.
        defaultPreloadStaleTime: 10_000,
        routeTree,
    });
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
