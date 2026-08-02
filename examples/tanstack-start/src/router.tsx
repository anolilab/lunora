import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { LunoraClient } from "lunorash/client";

import { routeTree } from "./routeTree.gen";

const isServer = typeof globalThis.window === "undefined";

/**
 * Where the loaders and the browser talk to Lunora.
 *
 * On the server that has to be an absolute URL — there is no page origin to be
 * relative to. In dev the composed worker serves both the SSR handler and
 * `/_lunora/*`, so it loops back to itself.
 */
const lunoraUrl = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? (isServer ? "http://localhost:5173" : globalThis.location.origin);

/**
 * Router factory. TanStack Start's build tooling expects this exact export name,
 * and calls it once per request on the server and once on the client.
 *
 * Both the `QueryClient` and the `LunoraClient` are created *here* rather than at
 * module scope: on the server they are per-request, and a module-level client
 * would leak one visitor's data (and eventually their identity) into the next
 * request's render.
 *
 * A `LunoraClient` only opens a socket when something subscribes. Loaders only
 * ever call `.query()`, so the server-side instance stays plain HTTP — the same
 * object then powers live subscriptions once it reaches the browser.
 */
export const getRouter = (): ReturnType<typeof createTanStackRouter> => {
    const lunora = new LunoraClient({ url: lunoraUrl });

    const queryClient = new QueryClient({
        defaultOptions: {
            queries: {
                // Lunora pushes; nothing goes stale on a timer. Without this,
                // TanStack would refetch over HTTP and race the subscription.
                staleTime: Number.POSITIVE_INFINITY,
            },
        },
    });

    return createTanStackRouter({
        context: { lunora, queryClient },
        defaultPreload: "intent",
        routeTree,
        scrollRestoration: true,
    });
};

declare module "@tanstack/react-router" {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}
