import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import type { PaginationResult } from "@lunora/client/pagination";
import { get } from "svelte/store";
import { describe, expect, it, vi } from "vitest";

import { infiniteQuery, paginatedQuery } from "../src/paginated-query";

interface SubscribeCall {
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
    functionPath: string;
}

const createFakePaginatedClient = () => {
    const subscribeCalls: SubscribeCall[] = [];

    const subscribe = (function_: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void): Unsubscribe => {
        subscribeCalls.push({
            args,
            callback,
            functionPath: function_["__lunoraRef"],
        });

        return () => undefined;
    };

    const client = { subscribe } as unknown as LunoraClient;

    const push = (args: Record<string, unknown>, value: unknown): void => {
        const argsKey = JSON.stringify(args);

        for (const call of subscribeCalls) {
            if (JSON.stringify(call.args) === argsKey) {
                call.callback(value);
            }
        }
    };

    return { client, push, subscribeCalls };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

const fn = { __lunoraRef: "messages:list" } as FunctionReference;

/**
 * Tests use `initialNumItems: 5` and push exactly 5 items per page so that
 * the rebalance thresholds (JOIN at < 0.5×5 = 2.5, SPLIT at > 2×5 = 10) are
 * never crossed. This lets the tests verify the pagination lifecycle without
 * triggering split/join maintenance passes.
 */
const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

describe("paginatedQuery (Svelte)", () => {
    it("first page loads and results flatten", async () => {
        const fake = createFakePaginatedClient();

        const { results, status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        expect(get(status)).toBe("LoadingFirstPage");
        expect(get(results)).toStrictEqual([]);

        const firstPage: PaginationResult<{ id: string }> = {
            continueCursor: "cur-1",
            isDone: false,
            page: firstPageItems,
        };

        fake.push({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }, firstPage);
        await flushAsync();

        expect(get(status)).toBe("CanLoadMore");
        expect(get(results)).toStrictEqual(firstPageItems);

        stopStatus();
        stopResults();
    });

    it("loadMore appends a second page", async () => {
        const fake = createFakePaginatedClient();

        const { loadMore, results, status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        // Deliver first page.
        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(status)).toBe("CanLoadMore");

        // Call loadMore.
        loadMore(NUM_ITEMS);
        await flushAsync();

        // Second page subscription.
        fake.push(
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );
        await flushAsync();

        expect(get(results)).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(get(status)).toBe("Exhausted");

        stopStatus();
        stopResults();
    });

    it("skip short-circuits to LoadingFirstPage", async () => {
        const fake = createFakePaginatedClient();

        const { status } = paginatedQuery(fake.client, fn, "skip", { initialNumItems: NUM_ITEMS });
        const stopStatus = status.subscribe(() => {});

        await flushAsync();

        expect(get(status)).toBe("LoadingFirstPage");
        expect(fake.subscribeCalls).toHaveLength(0);

        stopStatus();
    });

    it("last page reports Exhausted", async () => {
        const fake = createFakePaginatedClient();

        const { status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });
        const stopStatus = status.subscribe(() => {});

        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(status)).toBe("Exhausted");

        stopStatus();
    });
});

describe("infiniteQuery (Svelte)", () => {
    it("first page loads as first page array", async () => {
        const fake = createFakePaginatedClient();

        const { isLoading, pages } = infiniteQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopLoading = isLoading.subscribe(() => {});
        const stopPages = pages.subscribe(() => {});

        expect(get(isLoading)).toBe(true);
        expect(get(pages)).toStrictEqual([]);

        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(isLoading)).toBe(false);
        expect(get(pages)).toStrictEqual([firstPageItems]);

        stopLoading();
        stopPages();
    });

    it("fetchNextPage appends second page array", async () => {
        const fake = createFakePaginatedClient();

        const { fetchNextPage, pages } = infiniteQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });
        const stopPages = pages.subscribe(() => {});

        // First page.
        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        fetchNextPage();
        await flushAsync();

        // Second page.
        fake.push(
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );
        await flushAsync();

        expect(get(pages)).toStrictEqual([firstPageItems, secondPageItems]);

        stopPages();
    });
});
