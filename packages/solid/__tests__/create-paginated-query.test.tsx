import type { FunctionReference } from "@lunora/client";
import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

import { createInfiniteQuery, createPaginatedQuery } from "../src/create-paginated-query";
import { LunoraProvider } from "../src/lunora-provider";
import { createFakeClient } from "./fake-client";

const fn = { __lunoraRef: "messages:list" } as FunctionReference;

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

/**
 * Tests use `initialNumItems: 5` and push exactly 5 items per page so that
 * the rebalance thresholds (JOIN at < 0.5×5 = 2.5, SPLIT at > 2×5 = 10) are
 * never crossed. This lets the tests verify the pagination lifecycle without
 * triggering split/join maintenance passes.
 */
const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

describe("createPaginatedQuery (Solid)", () => {
    it("first page loads and results flatten", async () => {
        const fake = createFakeClient();
        let capturedStatus: (() => string) | undefined;
        let capturedResults: (() => unknown[]) | undefined;

        render(
            () => {
                const { results, status } = createPaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS });
                capturedStatus = status;
                capturedResults = results;

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(capturedStatus!()).toBe("LoadingFirstPage");
        expect(capturedResults!()).toStrictEqual([]);

        const firstPageSub = fake.subscriptions.find(
            (sub) => JSON.stringify(sub.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        firstPageSub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("CanLoadMore");
        expect(capturedResults!()).toStrictEqual(firstPageItems);
    });

    it("loadMore appends a second page", async () => {
        const fake = createFakeClient();
        let capturedLoadMore: ((n: number) => void) | undefined;
        let capturedStatus: (() => string) | undefined;
        let capturedResults: (() => unknown[]) | undefined;

        render(
            () => {
                const { loadMore, results, status } = createPaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS });
                capturedLoadMore = loadMore;
                capturedStatus = status;
                capturedResults = results;

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // Deliver first page.
        const firstPageSub = fake.subscriptions.find(
            (sub) => JSON.stringify(sub.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        firstPageSub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("CanLoadMore");

        // Call loadMore.
        capturedLoadMore!(NUM_ITEMS);
        await flushAsync();

        // Second page subscription should have opened.
        const secondPageSub = fake.subscriptions.find(
            (sub) => JSON.stringify(sub.args) === JSON.stringify({ paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } }),
        );

        secondPageSub?.push({ continueCursor: null, isDone: true, page: secondPageItems });
        await flushAsync();

        expect(capturedResults!()).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(capturedStatus!()).toBe("Exhausted");
    });

    it("skip short-circuits to LoadingFirstPage", async () => {
        const fake = createFakeClient();
        let capturedStatus: (() => string) | undefined;

        render(
            () => {
                const { status } = createPaginatedQuery(fn, "skip", { initialNumItems: NUM_ITEMS });
                capturedStatus = status;

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        await flushAsync();

        expect(capturedStatus!()).toBe("LoadingFirstPage");
        expect(fake.subscriptions).toHaveLength(0);
    });

    it("last page reports Exhausted", async () => {
        const fake = createFakeClient();
        let capturedStatus: (() => string) | undefined;

        render(
            () => {
                const { status } = createPaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS });
                capturedStatus = status;

                return <pre>{status()}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        const sub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        sub?.push({ continueCursor: null, isDone: true, page: firstPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("Exhausted");
    });
});

describe("createInfiniteQuery (Solid)", () => {
    it("first page loads as first page array", async () => {
        const fake = createFakeClient();
        let capturedPages: (() => unknown[][]) | undefined;
        let capturedIsLoading: (() => boolean) | undefined;

        render(
            () => {
                const { isLoading, pages } = createInfiniteQuery(fn, {}, { initialNumItems: NUM_ITEMS });
                capturedPages = pages;
                capturedIsLoading = isLoading;

                return <pre>{isLoading() ? "loading" : "loaded"}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        expect(capturedIsLoading!()).toBe(true);

        const sub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        sub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(capturedIsLoading!()).toBe(false);
        expect(capturedPages!()).toStrictEqual([firstPageItems]);
    });

    it("fetchNextPage appends second page array", async () => {
        const fake = createFakeClient();
        let capturedFetchNext: ((n?: number) => void) | undefined;
        let capturedPages: (() => unknown[][]) | undefined;

        render(
            () => {
                const { fetchNextPage, pages } = createInfiniteQuery(fn, {}, { initialNumItems: NUM_ITEMS });
                capturedFetchNext = fetchNextPage;
                capturedPages = pages;

                return <pre>{pages().length}</pre>;
            },
            { wrapper: (props) => <LunoraProvider client={fake.asClient}>{props.children}</LunoraProvider> },
        );

        // First page.
        const firstSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        firstSub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        capturedFetchNext!();
        await flushAsync();

        const secondSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } }),
        );

        secondSub?.push({ continueCursor: null, isDone: true, page: secondPageItems });
        await flushAsync();

        expect(capturedPages!()).toStrictEqual([firstPageItems, secondPageItems]);
    });
});
