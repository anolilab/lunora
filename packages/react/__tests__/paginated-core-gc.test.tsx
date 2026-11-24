import type { FunctionReference } from "@lunora/client";
import { QueryClient } from "@tanstack/react-query";
import { act, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";
import { createMockClient } from "./mock-client";

const makeRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

/** Keyset-style backend over a fixed list, cursor = next offset as a string. */
const makePaginator =
    (items: string[]) =>
    (_reference: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string; numItems: number } };
        const offset = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const end = offset + paginationOpts.numItems;
        const page = items.slice(offset, end);

        return { continueCursor: end >= items.length ? null : String(end), isDone: end >= items.length, page };
    };

const Harness = (): ReactElement => {
    const { results, status } = usePaginatedQuery(makeRef("items:list"), {}, { initialNumItems: 2 });

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
        </div>
    );
};

const GC_TIME_MS = 30;

/**
 * Move the fake clock by `ms` inside `act`, so the timers query-core runs on — its gc timeout and
 * the `setTimeout(0)` its notifyManager delivers cache updates on — fire and React commits what
 * they caused.
 */
const advance = async (ms: number): Promise<void> => {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
};

/**
 * `usePaginatedQuery` / `useInfiniteQuery` are the only hooks that write and
 * read the TanStack cache with **no observer** (`fetchQuery` + `getQueryData`,
 * never `useQuery`). query-core collects a query when
 * `!observers.length && fetchStatus === "idle"` — `addObserver -> clearGcTimeout()`
 * is exactly why `useQuery` is immune and these are not. A page that saw no
 * server row change past `gcTime` was therefore evicted while still mounted,
 * blanking the feed back to `LoadingFirstPage` with `loadMore` a permanent
 * no-op, and the hook could not even notice: its cache subscriber filters
 * `event.type !== "updated"`, and eviction emits `"removed"`.
 *
 * `gcTime` here is 30ms rather than the provider's 5 minutes so the eviction
 * window is reachable in a test; nothing else about the path differs. The gc
 * timer is a real `setTimeout` in query-core, so the clock is faked and moved
 * past it rather than waited out.
 */
describe("usePaginatedQuery — cache gc", () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("keeps a mounted page's rows past gcTime", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d"]));
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: GC_TIME_MS, retry: 0 } } });
        const tree = (
            <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                <Harness />
            </LunoraProvider>
        );
        const view = render(tree);

        // The first page lands; nothing else is due yet.
        await advance(0);

        expect(screen.getByTestId("results").textContent).toBe("a,b");

        // Well past gcTime, with no server frame to refresh the entry — exactly
        // the "open a feed and stay on the screen" case.
        await advance(GC_TIME_MS * 4);

        expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

        // The eviction itself is invisible until something re-renders:
        // `pageResults` is derived in the render body, and the hook's cache
        // subscriber drops the `"removed"` event gc emits — so the feed keeps
        // painting the last committed rows until any unrelated render (a parent
        // update, a route change, `loadMore`) turns them into a spinner.
        view.rerender(tree);

        expect(screen.getByTestId("results").textContent).toBe("a,b");
        expect(screen.getByTestId("status").textContent).not.toBe("LoadingFirstPage");
    });

    it("releases the page from the cache once the hook unmounts", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d"]));
        const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: GC_TIME_MS, retry: 0 } } });

        const view = render(
            <LunoraProvider client={mock.asClient} queryClient={queryClient}>
                <Harness />
            </LunoraProvider>,
        );

        await advance(0);

        expect(screen.getByTestId("results").textContent).toBe("a,b");
        expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0);

        // Pinning a page against gc must not turn into a permanent leak: the
        // hook owns the entry's whole lifecycle, so detach releases it.
        // The release is the detach itself, not a gc that runs later.
        view.unmount();

        expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
    });
});
