import type { RefObject } from "react";
import { useRef, useState } from "react";

import { useMirroredRef } from "../../../hooks/use-mirrored-ref";
import type { FacetResult } from "../../../lib/admin";
import { errorMessage, fireAndForget } from "../../../lib/internal";

/**
 * One faceted column's current state for the facet sidebar: whether its summary
 * has loaded (`result`), is still loading, or failed. Keyed by column in the
 * `facets` map; absent → not toggled on.
 */
interface FacetState {
    error: null | string;
    loading: boolean;
    result: FacetResult | null;
}

/**
 * Fetch one column's facet summary over the caller's current view. The hook owns
 * the loading/result/error slot transitions; the caller binds table/shard/filters
 * /search into this closure. A structurally-compatible payload (e.g. the global
 * tier's `GlobalFacetResult`) is accepted via the `FacetResult` shape.
 */
type FacetFetcher = (column: string) => Promise<FacetResult>;

interface UseFacets {
    /** Drop every open facet (e.g. when the selected table changes). */
    clearFacets: () => void;
    /** Per-column facet state for every toggled-on column; absent → not faceting that column. */
    facets: Record<string, FacetState>;
    /** Latest `facets` mirrored into a ref, so poll ticks / filter handlers read the current set without re-binding. */
    facetsRef: RefObject<Record<string, FacetState>>;
    /** Refetch every toggled-on facet over the view bound into `fetcher` (after a filter change or on a poll tick). */
    refetchFacets: (fetcher: FacetFetcher) => void;
    /** Toggle a column into / out of the facet sidebar. Turning it on seeds a loading slot and (when `fetcher` is non-null) fetches its summary for the active view; turning it off drops it. Pass `null` when no table is selected to seed the slot without fetching. */
    toggleFacet: (column: string, fetcher: FacetFetcher | null) => void;
}

/**
 * Shared facet (Datasette-style per-column value/count summary) state machine for
 * the data browsers. Both the shard browser (`useDataBrowser`) and the global
 * (D1-backed) browser (`GlobalDataBrowser`) toggle columns into a sidebar, fetch
 * a summary over the active view, and refetch the open ones when the view changes
 * — only the per-view fetch call differs, so each caller supplies a `FacetFetcher`
 * and the hook owns the loading/result/error transitions, the toggle add/remove,
 * and the bulk refetch.
 */
export const useFacets = (): UseFacets => {
    const [facets, setFacets] = useState<Record<string, FacetState>>({});
    const facetsRef = useMirroredRef(facets);

    // Per-column monotonic fetch id. `refetchFacets` fires on every filter/search/
    // shard/table change while older fetches may still be in flight, so a slow
    // response for a previous view could otherwise land last and paint stale
    // value/count summaries that don't match the visible rows. Only the latest
    // fetch for a column is allowed to write its result.
    const fetchSeq = useRef<Record<string, number>>({});

    const fetchFacet = async (column: string, fetcher: FacetFetcher): Promise<void> => {
        const seq = (fetchSeq.current[column] ?? 0) + 1;

        fetchSeq.current[column] = seq;

        setFacets((current) =>
            column in current ? { ...current, [column]: { error: null, loading: true, result: current[column]?.result ?? null } } : current,
        );

        try {
            const result = await fetcher(column);

            if (fetchSeq.current[column] !== seq) {
                return;
            }

            setFacets((current) => (column in current ? { ...current, [column]: { error: null, loading: false, result } } : current));
        } catch (error) {
            if (fetchSeq.current[column] !== seq) {
                return;
            }

            setFacets((current) => (column in current ? { ...current, [column]: { error: errorMessage(error), loading: false, result: null } } : current));
        }
    };

    const toggleFacet = (column: string, fetcher: FacetFetcher | null): void => {
        // Read the current set from the ref and kick the fetch off OUTSIDE the state
        // updater: React may invoke an updater more than once (StrictMode dev, render
        // replays), and a side effect (a facet request) inside one would double-fire.
        if (column in facetsRef.current) {
            setFacets((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== column)));

            return;
        }

        setFacets((current) => {
            return { ...current, [column]: { error: null, loading: true, result: null } };
        });

        if (fetcher !== null) {
            fireAndForget(fetchFacet(column, fetcher));
        }
    };

    const refetchFacets = (fetcher: FacetFetcher): void => {
        for (const column of Object.keys(facetsRef.current)) {
            fireAndForget(fetchFacet(column, fetcher));
        }
    };

    const clearFacets = (): void => {
        setFacets({});
    };

    return { clearFacets, facets, facetsRef, refetchFacets, toggleFacet };
};

export type { FacetFetcher, FacetState };
