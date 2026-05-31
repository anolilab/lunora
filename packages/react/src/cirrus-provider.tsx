import type { CirrusClient } from "@cirrus/client";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { createContext, type ReactElement, type ReactNode, use, useState } from "react";

const CirrusContext = createContext<CirrusClient | null>(null);

export interface CirrusProviderProps {
    children: ReactNode;
    client: CirrusClient;
    /**
     * Bring-your-own QueryClient. When omitted, the provider creates one with
     * defaults tuned for Cirrus's push-driven model:
     *  - `staleTime: Infinity` — the WS subscription is the only invalidation signal.
     *  - `retry: 0` — failures route through the offline queue on the client.
     *  - `gcTime: 5min` — keep results around for a short return-to-view window.
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
            queries: {
                gcTime: 5 * 60_000,
                retry: 0,
                staleTime: Number.POSITIVE_INFINITY,
            },
            mutations: { retry: 0 },
        },
    });

/**
 * Provides both the {@link CirrusClient} and a TanStack `QueryClient` to the
 * tree. The detection logic for a parent QueryClientProvider keeps this safe to
 * drop into an app that already runs TanStack Query for its own purposes.
 */
export const CirrusProvider = ({ children, client, queryClient }: CirrusProviderProps): ReactElement => {
    const parentQueryClient = use(QueryClientContext);

    // The TanStack client we'll *render* with. Priority:
    //   1. Explicit `queryClient` prop wins.
    //   2. Inherit from a parent <QueryClientProvider> when present.
    //   3. Create one lazily (useState initializer) so the same instance
    //      survives re-renders.
    const [internalClient] = useState<QueryClient | undefined>(() => {
        if (queryClient) {
            return undefined;
        }

        if (parentQueryClient) {
            return undefined;
        }

        return createDefaultQueryClient();
    });

    const effectiveClient = queryClient ?? parentQueryClient ?? internalClient;

    if (!effectiveClient) {
        // The useState branch always produces a client when we need one, so
        // this is unreachable; the throw makes the type narrow for downstream
        // code without an `as`.
        throw new Error("CirrusProvider: failed to resolve a QueryClient");
    }

    const content = <CirrusContext value={client}>{children}</CirrusContext>;

    // Don't double-wrap when a parent already provides the client.
    if (parentQueryClient === effectiveClient) {
        return content;
    }

    return <QueryClientProvider client={effectiveClient}>{content}</QueryClientProvider>;
};

/**
 * Read the {@link CirrusClient} from the nearest `<CirrusProvider>`.
 *
 * eslint-disable-next-line react-refresh/only-export-components — kept colocated with the provider for back-compat.
 */
// eslint-disable-next-line react-refresh/only-export-components
export const useCirrus = (): CirrusClient => {
    const client = use(CirrusContext);

    if (!client) {
        throw new Error("useCirrus must be used inside <CirrusProvider />");
    }

    return client;
};
