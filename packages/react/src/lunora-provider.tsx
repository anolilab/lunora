"use client";

import type { LunoraClient } from "@lunora/client";
import { LunoraError } from "@lunora/errors";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { createContext, use, useEffect, useRef, useState } from "react";

import { getSubscriptionRegistry } from "./cache";

const LunoraContext = createContext<LunoraClient | null>(null);

/**
 * Whether the provider's `client` differs from the one it first rendered with.
 * A value preloaded on the server belongs to that first client, so a hook that
 * mounts after a swap must not seed it: its own `useState` only ever saw the
 * new client.
 */
const LunoraClientSwappedContext = createContext(false);

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
    const [internalClient] = useState<QueryClient>(() => queryClient ?? parentQueryClient ?? createDefaultQueryClient());

    const effectiveClient = queryClient ?? parentQueryClient ?? internalClient;

    // A sign-out or user switch must not leave the previous user's rows in the
    // TanStack cache, where a remounting query would read them back. Deliberately
    // not torn down on unmount: see `clearOnIdentityChange`.
    useEffect(() => {
        getSubscriptionRegistry(client).clearOnIdentityChange(effectiveClient);
    }, [client, effectiveClient]);

    // Swapping `client` does not remount the subtree, and the QueryClient (ours
    // or the caller's) outlives it: TanStack binds each mounted hook's observer
    // to one QueryClient for life, so a fresh QueryClient would not reach them.
    // The keys omit the client, so without this the new client would render
    // the old one's rows, which `staleTime: Infinity` never refetches. Clear the
    // `["lunora", …]` entries and refetch the ones on screen; this runs after
    // the children's effects, so their observers already hold query functions
    // bound to the new client.
    const previousClient = useRef(client);

    useEffect(() => {
        // eslint-disable-next-line react-you-might-not-need-an-effect/no-event-handler -- prop → external-store sync: a `client` swap must clear the TanStack cache, and no event in this component carries the swap. It must run post-commit, after the children's observers took the new client's query functions.
        if (previousClient.current === client) {
            return;
        }

        // The previous client's identity changes no longer concern this cache:
        // left registered, a later sign-out on it would blank the new client's
        // queries with nothing to refetch them.
        getSubscriptionRegistry(previousClient.current).stopClearingOnIdentityChange(effectiveClient);
        previousClient.current = client;
        getSubscriptionRegistry(client).clearQueries(effectiveClient);
        // eslint-disable-next-line @typescript-eslint/no-floating-promises -- fire-and-forget: a failed refetch lands on the query's own error state
        effectiveClient.invalidateQueries({ queryKey: ["lunora"] });
    }, [client, effectiveClient]);

    // The client the page loaded with, kept on purpose: a server-preloaded value
    // belongs to it, and a hook mounting after a swap never saw it.
    // react-doctor-disable-next-line react-doctor/no-derived-useState -- intentional: the FIRST `client` is the point, never re-synced to the prop
    const [firstClient] = useState(client);

    const content = (
        <LunoraContext value={client}>
            <LunoraClientSwappedContext value={client !== firstClient}>{children}</LunoraClientSwappedContext>
        </LunoraContext>
    );

    // Don't double-wrap when a parent already provides the client.
    if (parentQueryClient === effectiveClient) {
        return content;
    }

    return <QueryClientProvider client={effectiveClient}>{content}</QueryClientProvider>;
};

/** Whether the nearest `<LunoraProvider>` has swapped its `client` since it first rendered. */
const useLunoraClientSwapped = (): boolean => use(LunoraClientSwappedContext);

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
export { LunoraProvider, useLunora, useLunoraClientSwapped };
