"use client";

import type { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { createContext, use, useState } from "react";

const LunoraContext = createContext<LunoraClient | null>(null);

interface LunoraProviderProps {
    children: ReactNode;
    client: LunoraClient;

    /**
     * Bring-your-own QueryClient. When omitted, the provider creates one with
     * defaults tuned for Lunora's push-driven model: `staleTime: Infinity` (the
     * WS subscription is the only invalidation signal), `retry: 0` (failures
     * route through the offline queue on the client), and `gcTime: 5min` (keep
     * results around for a short return-to-view window).
     *
     * If a parent `<QueryClientProvider>` is already mounted, the provider
     * uses *that* client and does NOT install an inner one (so apps with their
     * own setup don't double-wrap).
     */
    queryClient?: QueryClient;
}

const createDefaultQueryClient = (): QueryClient =>
    new QueryClient({
        defaultOptions: {
            mutations: { retry: 0 },
            queries: {
                gcTime: 5 * 60_000,
                retry: 0,
                staleTime: Number.POSITIVE_INFINITY,
            },
        },
    });

/**
 * Provides both the {@link LunoraClient} and a TanStack `QueryClient` to the
 * tree. The detection logic for a parent QueryClientProvider keeps this safe to
 * drop into an app that already runs TanStack Query for its own purposes.
 */
const LunoraProvider = ({ children, client, queryClient }: LunoraProviderProps): ReactElement => {
    const parentQueryClient = use(QueryClientContext);

    // The TanStack client we'll *render* with. Priority:
    //   1. Explicit `queryClient` prop wins.
    //   2. Inherit from a parent <QueryClientProvider> when present.
    //   3. Create one lazily (useState initializer) so the same instance
    //      survives re-renders.
    const [internalClient] = useState<QueryClient | undefined>(() => queryClient ?? parentQueryClient ?? createDefaultQueryClient());

    const effectiveClient = queryClient ?? parentQueryClient ?? internalClient;

    if (!effectiveClient) {
        // The useState branch always produces a client when we need one, so
        // this is unreachable; the throw makes the type narrow for downstream
        // code without an `as`.
        throw new LunoraError("INTERNAL", "LunoraProvider: failed to resolve a QueryClient");
    }

    const content = <LunoraContext value={client}>{children}</LunoraContext>;

    // Don't double-wrap when a parent already provides the client.
    if (parentQueryClient === effectiveClient) {
        return content;
    }

    return <QueryClientProvider client={effectiveClient}>{content}</QueryClientProvider>;
};

/**
 * Read the {@link LunoraClient} from the nearest `<LunoraProvider>`. Kept
 * colocated with the provider for back-compat.
 */
const useLunora = (): LunoraClient => {
    const client = use(LunoraContext);

    if (!client) {
        throw new LunoraError("INTERNAL", "useLunora must be used inside <LunoraProvider />");
    }

    return client;
};

export type { LunoraProviderProps };
// eslint-disable-next-line react-refresh/only-export-components -- useLunora is a hook kept colocated with the provider component for back-compat; splitting it into its own module would break existing imports.
export { LunoraProvider, useLunora };
