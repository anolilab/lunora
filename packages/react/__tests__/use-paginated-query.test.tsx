import type { FunctionReference, SubscriptionErrorCallback } from "@lunora/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { LunoraProvider } from "../src/lunora-provider";
import { usePaginatedQuery } from "../src/use-paginated-query";
import { createMockClient } from "./mock-client";

const makeRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

/** Keyset-style backend over a fixed list, cursor = next offset as a string. */
const makePaginator =
    (items: string[]) =>
    (_ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string; numItems: number } };
        const offset = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
        const end = offset + paginationOpts.numItems;
        const page = items.slice(offset, end);
        const isDone = end >= items.length;

        return { continueCursor: isDone ? null : String(end), isDone, page };
    };

interface HarnessProps {
    initialNumItems?: number;
    onError?: SubscriptionErrorCallback;
    onLoadMore?: (loadMore: (numberItems: number) => void) => void;
    skip?: boolean;
}

const Harness = ({ initialNumItems: initialNumberItems = 2, onError, onLoadMore, skip = false }: HarnessProps): ReactElement => {
    const { error, isLoading, loadMore, results, status } = usePaginatedQuery(makeRef("items:list"), skip ? "skip" : {}, {
        initialNumItems: initialNumberItems,
        onError,
    });

    onLoadMore?.(loadMore);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="loading">{String(isLoading)}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
            <span data-testid="error">{error?.message ?? ""}</span>
        </div>
    );
};

/** A paginator that rejects for the page starting at `failAtCursor`, and serves the rest. */
const makeFailingPaginator = (items: string[], failAtCursor: null | string) => {
    const serve = makePaginator(items);

    return (ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
        const { paginationOpts } = args as { paginationOpts: { cursor: null | string } };

        if (paginationOpts.cursor === failAtCursor) {
            throw new Error("page unavailable");
        }

        return serve(ref, args);
    };
};

describe("usePaginatedQuery", () => {
    it("surfaces a first-page failure instead of loading forever", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makeFailingPaginator(["a", "b", "c"], null));
        const onError = vi.fn<SubscriptionErrorCallback>();

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness onError={onError} />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("page unavailable");
        });

        // The first page has nothing to fall back to, so it stays loading — but
        // the consumer can now see WHY.
        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "page unavailable" }));
    });

    it("drops a failed tail page so the feed leaves LoadingMore and loadMore can retry", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makeFailingPaginator(["a", "b", "c", "d", "e"], "2"));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("error").textContent).toBe("page unavailable");
        });

        // The failed tail is gone: the feed shows what it has and `loadMore` is
        // live again rather than pinned at "LoadingMore" forever.
        expect(screen.getByTestId("results").textContent).toBe("a,b");
        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
    });

    it("loads the first page and reports CanLoadMore when more remain", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness />
            </LunoraProvider>,
        );

        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("true");

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("loadMore appends pages and reaches Exhausted on the final page", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");

        act(() => {
            loadMore(2);
        });

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b,c,d,e");
        });

        expect(screen.getByTestId("status").textContent).toBe("Exhausted");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("loadMore is a no-op once Exhausted", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));

        let loadMore: (numberItems: number) => void = (_numberItems) => undefined;

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness
                    // eslint-disable-next-line react-perf/jsx-no-new-function-as-prop -- test harness callback used once to capture the hook's `loadMore`.
                    onLoadMore={(next) => {
                        loadMore = next;
                    }}
                />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("status").textContent).toBe("Exhausted");
        });

        expect(mock.query).toHaveBeenCalledTimes(1);

        act(() => {
            loadMore(2);
        });

        // No new page request — the single page already covered everything.
        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("results").textContent).toBe("a,b");
    });

    it('"skip" short-circuits — no query and stays LoadingFirstPage', () => {
        expect.assertions(4);

        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness skip />
            </LunoraProvider>,
        );

        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    it("a WS delta replaces a loaded page in place", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <LunoraProvider client={mock.asClient}>
                <Harness />
            </LunoraProvider>,
        );

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        act(() => {
            mock.emit("items:list", { continueCursor: null, isDone: true, page: ["a", "b", "z"] });
        });

        expect(screen.getByTestId("results").textContent).toBe("a,b,z");
    });
});
