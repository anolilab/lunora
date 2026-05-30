import type { FunctionReference } from "@cirrus/client";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, test } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { usePaginatedQuery } from "../src/use-paginated-query.js";
import { createMockClient } from "./mock-client.js";

const fn = (ref: string): FunctionReference => ({ __cirrusRef: ref });

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
    onLoadMore?: (loadMore: (numItems: number) => void) => void;
    skip?: boolean;
}

const Harness = ({ initialNumItems = 2, onLoadMore, skip = false }: HarnessProps): ReactElement => {
    const { isLoading, loadMore, results, status } = usePaginatedQuery(fn("items:list"), skip ? "skip" : ({} as Record<string, unknown>), { initialNumItems });

    onLoadMore?.(loadMore);

    return (
        <div>
            <span data-testid="status">{status}</span>
            <span data-testid="loading">{String(isLoading)}</span>
            <span data-testid="results">{(results as string[]).join(",")}</span>
        </div>
    );
};

describe("usePaginatedQuery", () => {
    test("loads the first page and reports CanLoadMore when more remain", async () => {
        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness />
            </CirrusProvider>,
        );

        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("true");

        await waitFor(() => {
            expect(screen.getByTestId("results").textContent).toBe("a,b");
        });

        expect(screen.getByTestId("status").textContent).toBe("CanLoadMore");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    test("loadMore appends pages and reaches Exhausted on the final page", async () => {
        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));

        let loadMore: (numItems: number) => void = () => undefined;

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness
                    onLoadMore={(function_) => {
                        loadMore = function_;
                    }}
                />
            </CirrusProvider>,
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

    test("loadMore is a no-op once Exhausted", async () => {
        const mock = createMockClient(makePaginator(["a", "b"]));

        let loadMore: (numItems: number) => void = () => undefined;

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness
                    onLoadMore={(function_) => {
                        loadMore = function_;
                    }}
                />
            </CirrusProvider>,
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

    test('"skip" short-circuits — no query and stays LoadingFirstPage', () => {
        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness skip />
            </CirrusProvider>,
        );

        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(screen.getByTestId("status").textContent).toBe("LoadingFirstPage");
        expect(screen.getByTestId("loading").textContent).toBe("false");
    });

    test("a WS delta replaces a loaded page in place", async () => {
        const mock = createMockClient(makePaginator(["a", "b"]));

        render(
            <CirrusProvider client={mock.asClient}>
                <Harness />
            </CirrusProvider>,
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
