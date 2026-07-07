import type { FunctionReference } from "@lunora/client";
import type { PaginationResult } from "@lunora/client/pagination";
import { describe, expect, it } from "vitest";

import { infiniteQuery, paginatedQuery } from "../src/paginated-query";
import type { FakeClient } from "./fake-client";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const fn = { __lunoraRef: "messages:list" } as FunctionReference;

const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

const pushByArgs = (fake: FakeClient, args: Record<string, unknown>, value: PaginationResult<{ id: string }>): void => {
    const key = JSON.stringify(args);

    for (const sub of fake.subscriptions) {
        if (JSON.stringify(sub.args) === key && !sub.unsubscribed) {
            sub.push(value);
        }
    }
};

describe(paginatedQuery, () => {
    it("first page loads and results flatten", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { results, status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(status()).toBe("LoadingFirstPage");
        expect(results()).toStrictEqual([]);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("CanLoadMore");
        expect(results()).toStrictEqual(firstPageItems);
    });

    it("loadMore appends a second page", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { loadMore, results, status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("CanLoadMore");

        loadMore(NUM_ITEMS);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );

        expect(results()).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(status()).toBe("Exhausted");
    });

    it("skip short-circuits to LoadingFirstPage with no subscriptions", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { status } = paginatedQuery(fn, "skip", { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(status()).toBe("LoadingFirstPage");
        expect(fake.subscriptions).toHaveLength(0);
    });

    it("last page reports Exhausted", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("Exhausted");
    });

    it("tears down all subscriptions on destroy", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
    });
});

describe(infiniteQuery, () => {
    it("first page loads as first page array", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { isLoading, pages } = infiniteQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(isLoading()).toBe(true);
        expect(pages()).toStrictEqual([]);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(isLoading()).toBe(false);
        expect(pages()).toStrictEqual([firstPageItems]);
    });

    it("fetchNextPage appends second page array", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { fetchNextPage, pages } = infiniteQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        fetchNextPage();

        pushByArgs(
            fake,
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );

        expect(pages()).toStrictEqual([firstPageItems, secondPageItems]);
    });
});
