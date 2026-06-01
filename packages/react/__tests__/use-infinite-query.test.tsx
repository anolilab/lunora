import type { FunctionReference } from "@cirrus/client";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { CirrusProvider } from "../src/cirrus-provider.js";
import { useInfiniteQuery } from "../src/use-infinite-query.js";
import { createMockClient } from "./mock-client.js";

const function_ = (ref: string): FunctionReference => {
    return { __cirrusRef: ref };
};

/** Keyset-style backend over a fixed list, cursor = next offset as a string. */
const makePaginator
    = (items: string[]) =>
        (_ref: string, args: unknown): { continueCursor: null | string; isDone: boolean; page: string[] } => {
            const { paginationOpts } = args as { paginationOpts: { cursor: null | string; numItems: number } };
            const offset = paginationOpts.cursor ? Number(paginationOpts.cursor) : 0;
            const end = offset + paginationOpts.numItems;
            const page = items.slice(offset, end);
            const isDone = end >= items.length;

            return { continueCursor: isDone ? null : String(end), isDone, page };
        };

const wrapper
    = (client: ReturnType<typeof createMockClient>["asClient"]) =>
        ({ children }: PropsWithChildren): ReactElement => <CirrusProvider client={client}>{children}</CirrusProvider>;

describe("useInfiniteQuery", () => {
    it("loads the first page into pages[0]", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), {}, { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        expect(result.current.status).toBe("LoadingFirstPage");
        expect(result.current.isLoading).toBe(true);
        expect(result.current.pages).toEqual([]);

        await waitFor(() => {
            expect(result.current.pages).toEqual([["a", "b"]]);
        });

        expect(result.current.status).toBe("CanLoadMore");
        expect(result.current.hasNextPage).toBe(true);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.isFetchingNextPage).toBe(false);
    });

    it("fetchNextPage appends a discrete second page", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), {}, { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        await waitFor(() => {
            expect(result.current.pages).toEqual([["a", "b"]]);
        });

        act(() => {
            result.current.fetchNextPage();
        });

        await waitFor(() => {
            expect(result.current.pages).toHaveLength(2);
        });

        expect(result.current.pages).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
        expect(result.current.status).toBe("CanLoadMore");
    });

    it("hasNextPage flips false once the tail reports isDone", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), {}, { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        await waitFor(() => {
            expect(result.current.status).toBe("Exhausted");
        });

        expect(result.current.pages).toEqual([["a", "b"]]);
        expect(result.current.hasNextPage).toBe(false);
        expect(result.current.isFetchingNextPage).toBe(false);
    });

    it("fetchNextPage is a no-op when there is no next page", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), {}, { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        await waitFor(() => {
            expect(result.current.status).toBe("Exhausted");
        });

        expect(mock.query).toHaveBeenCalledTimes(1);

        act(() => {
            result.current.fetchNextPage();
        });

        expect(mock.query).toHaveBeenCalledTimes(1);
        expect(result.current.pages).toEqual([["a", "b"]]);
    });

    it("\"skip\" yields empty pages and is not loading", () => {
        expect.assertions(6);

        const mock = createMockClient(makePaginator(["a", "b"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), "skip", { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        expect(mock.query).not.toHaveBeenCalled();
        expect(mock.subscribe).not.toHaveBeenCalled();
        expect(result.current.pages).toEqual([]);
        expect(result.current.hasNextPage).toBe(false);
        expect(result.current.isLoading).toBe(false);
        expect(result.current.status).toBe("LoadingFirstPage");
    });

    it("a delta to page 0 updates pages[0] in place while page 1 stays", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const { result } = renderHook(() => useInfiniteQuery(function_("items:list"), {}, { initialNumItems: 2 }), {
            wrapper: wrapper(mock.asClient),
        });

        await waitFor(() => {
            expect(result.current.pages).toEqual([["a", "b"]]);
        });

        act(() => {
            result.current.fetchNextPage();
        });

        await waitFor(() => {
            expect(result.current.pages).toHaveLength(2);
        });

        // Push a delta only to page 0's subscription (cursor === null) so page 1 stays untouched.
        const pageZeroCall = mock.subscribe.mock.calls.find(
            ([, args]) => (args as { paginationOpts: { cursor: null | string } }).paginationOpts.cursor === null,
        );
        const pageZeroCallback = pageZeroCall?.[2] as (value: unknown) => void;

        act(() => {
            pageZeroCallback({ continueCursor: "3", isDone: false, page: ["a", "b", "x"] });
        });

        expect(result.current.pages).toEqual([
            ["a", "b", "x"],
            ["c", "d"],
        ]);
    });

    it("changing base args resets to the first page", async () => {
        expect.hasAssertions();

        const mock = createMockClient(makePaginator(["a", "b", "c", "d", "e"]));
        const { rerender, result } = renderHook(({ kind }: { kind: string }) => useInfiniteQuery(function_("items:list"), { kind }, { initialNumItems: 2 }), {
            initialProps: { kind: "first" },
            wrapper: wrapper(mock.asClient),
        });

        await waitFor(() => {
            expect(result.current.pages).toEqual([["a", "b"]]);
        });

        act(() => {
            result.current.fetchNextPage();
        });

        await waitFor(() => {
            expect(result.current.pages).toHaveLength(2);
        });

        rerender({ kind: "second" });

        expect(result.current.status).toBe("LoadingFirstPage");

        await waitFor(() => {
            expect(result.current.pages).toEqual([["a", "b"]]);
        });
    });
});
