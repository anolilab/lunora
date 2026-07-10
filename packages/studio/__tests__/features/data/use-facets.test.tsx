import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { FacetFetcher } from "../../../src/features/data/hooks/use-facets";
import { useFacets } from "../../../src/features/data/hooks/use-facets";
import type { FacetResult } from "../../../src/lib/admin";

const facetResult = (label: string): FacetResult => {
    return { truncated: false, values: [{ count: 1, value: label }] };
};

describe("useFacets", () => {
    it("fires exactly one fetch when a column is toggled on (fetch is not inside the state updater)", async () => {
        expect.assertions(2);

        const fetcher = vi.fn<FacetFetcher>(async () => facetResult("a"));

        const { result } = renderHook(() => useFacets());

        await act(async () => {
            result.current.toggleFacet("status", fetcher);
            // Flush the fire-and-forget fetch: the fetcher microtask, then the
            // continuation that writes the result back into state.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(result.current.facets["status"]?.result).toStrictEqual(facetResult("a"));
    });

    it("ignores a superseded facet response so the latest view wins regardless of resolution order", async () => {
        expect.assertions(1);

        // Deferred promises so the test controls resolution order: the FIRST (stale)
        // fetch resolves AFTER the second, and must not overwrite the newer result.
        const deferred: ((value: FacetResult) => void)[] = [];
        const fetcher = vi.fn<FacetFetcher>(
            () =>
                new Promise<FacetResult>((resolve) => {
                    deferred.push(resolve);
                }),
        );

        const { result } = renderHook(() => useFacets());

        // Open the facet (its own fetch is deferred[0]).
        act(() => {
            result.current.toggleFacet("status", fetcher);
        });

        // A view change refetches the open facet (deferred[1]).
        act(() => {
            result.current.refetchFacets(fetcher);
        });

        // Resolve the NEWER fetch first, then the older/stale one.
        await act(async () => {
            deferred[1]?.(facetResult("new"));
            await Promise.resolve();
            deferred[0]?.(facetResult("stale"));
            await Promise.resolve();
        });

        expect(result.current.facets["status"]?.result).toStrictEqual(facetResult("new"));
    });
});
