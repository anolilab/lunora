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

describe("createPaginatedQuery pending-page rebalance guard (BUG 2 regression)", () => {
    it("shrinking edit on old tail before new page resolves does not undo loadMore", async () => {
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

        // Deliver a full first page.
        const firstSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        firstSub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("CanLoadMore");

        // Call loadMore.
        capturedLoadMore!(NUM_ITEMS);
        await flushAsync();

        // Page 2 is open but has NOT resolved yet.
        // Push a shrinking update on the pinned page-1 (1 item < JOIN_FACTOR × 5 = 2.5).
        // With the original bug, this triggered JOIN which merged away the not-yet-resolved
        // page-2, silently undoing loadMore.
        const pinnedFirstSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: "cur-1", numItems: NUM_ITEMS } }),
        );

        pinnedFirstSub?.push({ continueCursor: "cur-1", isDone: false, page: [{ id: "a" }] });
        await flushAsync();

        // Rebalance must be suppressed — page-2 is still pending.
        // Status must remain "LoadingMore", NOT "Exhausted" or "CanLoadMore".
        expect(capturedStatus!()).toBe("LoadingMore");

        // Results must contain only the 1 shrunken item from page-1; page-2 not yet resolved.
        expect(capturedResults!()).toHaveLength(1);
    });
});

describe("createPaginatedQuery rebalance migration (FINDING 1 regression)", () => {
    it("a SPLIT preserves already-loaded results and does not regress to LoadingFirstPage", async () => {
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

        // First (open-ended) page resolves with a cursor → CanLoadMore.
        const firstSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }),
        );

        firstSub?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("CanLoadMore");

        // loadMore pins page 0 as a bounded (null, cur-1] range and appends a tail.
        capturedLoadMore!(NUM_ITEMS);
        await flushAsync();

        // Resolve the tail so `pendingPageKeys` empties (rebalance is then allowed).
        const tailSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } }),
        );

        tailSub?.push({ continueCursor: null, isDone: true, page: secondPageItems });
        await flushAsync();

        expect(capturedStatus!()).toBe("Exhausted");
        expect(capturedResults!()).toHaveLength(firstPageItems.length + secondPageItems.length);

        // The bounded page 0 now grows past the SPLIT threshold (> 2×5) and reports a
        // `splitCursor`, so rebalance cuts it into (null, mid] and (mid, cur-1].
        const grownFirstPage = Array.from({ length: 11 }, (_, index) => {return { id: `g${index}` }});

        const boundedFirstSub = fake.subscriptions.find(
            (s) => JSON.stringify(s.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: "cur-1", numItems: NUM_ITEMS } }),
        );

        boundedFirstSub?.push({ continueCursor: "cur-1", isDone: false, page: grownFirstPage, splitCursor: "mid" });
        await flushAsync();

        // Without the rebalance migration, the new (null, mid] page maps to no result:
        // results collapse to just the tail page and status regresses to
        // "LoadingFirstPage". With the migration, the grown page's items survive.
        expect(capturedStatus!()).not.toBe("LoadingFirstPage");
        expect(capturedStatus!()).toBe("Exhausted");
        expect(capturedResults!()).toHaveLength(grownFirstPage.length + secondPageItems.length);
        expect(capturedResults!()).toStrictEqual([...grownFirstPage, ...secondPageItems]);
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
