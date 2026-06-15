import type { FunctionReference } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { useRef } from "react";
import { describe, expect, it } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Keyset paginator over a fixed list; cursor = next offset as a string. */
const makePaginator =
    (items: string[]) =>
    (_ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string; numItems: number } };
        const offset = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const end = offset + paginationOpts.numItems;
        const page = items.slice(offset, end);

        return { continueCursor: end >= items.length ? null : String(end), isDone: end >= items.length, page };
    };

interface HarnessProps {
    onRenderCount?: (count: number) => void;
}

const Harness = ({ onRenderCount }: HarnessProps): ReactElement => {
    const { results, status } = usePaginatedQuery(makeRef("items:list"), {}, { initialNumItems: 2 });
    const renderCount = useRef(0);

    renderCount.current += 1;
    onRenderCount?.(renderCount.current);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
        </div>
    );
};

describe("cache-event filtering (paginated hook)", () => {
    it("does not re-render on observer-lifecycle events for unrelated queries", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d"]));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: Number.POSITIVE_INFINITY } } });

        const tracker = { latest: 0 };
        // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- stable per-test callback that records the harness render count.
        const recordRenderCount = (count: number): void => {
            tracker.latest = count;
        };

        render(
            <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                <Harness onRenderCount={recordRenderCount} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        const rendersAfterLoad = tracker.latest;

        // Drive a flurry of non-data events on an unrelated query directly
        // through the shared QueryCache. The fix early-returns on these, so the
        // hook must not re-render.
        const cache = queryClient.getQueryCache();
        const unrelated = cache.build(queryClient, { queryKey: ["lunora", "other:list", {}, null] });

        act(() => {
            for (let index = 0; index < 25; index += 1) {
                cache.notify({ query: unrelated, type: "observerResultsUpdated" } as never);
                cache.notify({ query: unrelated, type: "observerAdded" } as never);
                cache.notify({ query: unrelated, type: "added" } as never);
            }
        });

        // No additional renders were provoked by the unrelated non-data events.
        expect(tracker.latest).toBe(rendersAfterLoad);
    });

    it("re-renders when a loaded page receives a data update", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d"]));
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: Number.POSITIVE_INFINITY } } });

        render(
            <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                <Harness />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        // The registry pushes new page data via setQueryData -> "updated" event.
        act(() => {
            mock.emit("items:list", { continueCursor: "2", isDone: false, page: ["X", "Y"] });
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("X,Y");
        });
    });
});
