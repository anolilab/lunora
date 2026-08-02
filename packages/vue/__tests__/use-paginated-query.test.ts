import type { PaginationResult } from "@lunora/client/pagination";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { useInfiniteQuery, usePaginatedQuery } from "../src/use-paginated-query";
import { createFakeClient } from "./fake-client";

/** Flush reactive microtask queue. */
const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
    await nextTick();
    await nextTick();
};

/** Minimal paginated query function reference. */
const fn = { __lunoraRef: "messages:list" } as Parameters<typeof usePaginatedQuery>[0];

/**
 * Tests use `initialNumItems: 5` and push exactly 5 items per page so that
 * the rebalance thresholds (JOIN at < 0.5×5 = 2.5, SPLIT at > 2×5 = 10) are
 * never crossed. This lets the tests verify the pagination lifecycle without
 * triggering split/join maintenance passes.
 */
const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

describe("usePaginatedQuery (Vue)", () => {
    // `usePaginatedQuery` is built on the paginated core, which gates opening
    // page subscriptions on a browser `window` (SSR guard); the vitest env is
    // `node` (no `window`), so define one for these client-path tests. The
    // dedicated SSR test below removes it to exercise the guard, mirroring
    // `@lunora/vue`'s `use-presence.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("first page loads and results flatten", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        expect(result.status.value).toBe("LoadingFirstPage");
        expect(result.results.value).toStrictEqual([]);

        // Push a first-page result.
        const firstPage: PaginationResult<{ id: string }> = {
            continueCursor: "cur-1",
            isDone: false,
            page: firstPageItems,
        };

        fake.push("messages:list", { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }, firstPage);
        await flushAsync();

        expect(result.status.value).toBe("CanLoadMore");
        expect(result.results.value).toStrictEqual(firstPageItems);

        scope.stop();
    });

    it("loadMore appends a second page", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        // Deliver first page.
        fake.push(
            "messages:list",
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(result.status.value).toBe("CanLoadMore");

        // Call loadMore.
        result.loadMore(NUM_ITEMS);
        await flushAsync();

        // The second page subscription should have been opened.
        const secondPageArgs = { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } };
        const secondPage: PaginationResult<{ id: string }> = {
            continueCursor: null,
            isDone: true,
            page: secondPageItems,
        };

        fake.push("messages:list", secondPageArgs, secondPage);
        await flushAsync();

        expect(result.results.value).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(result.status.value).toBe("Exhausted");

        scope.stop();
    });

    it("skip short-circuits and sets status to LoadingFirstPage", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, "skip", { initialNumItems: NUM_ITEMS })))!;

        await flushAsync();

        expect(result.status.value).toBe("LoadingFirstPage");
        expect(result.results.value).toStrictEqual([]);

        scope.stop();
    });

    it("does not reset the feed when args is replaced with a deep-equal object", async () => {
        const fake = createFakeClient();
        const argsRef = ref<Record<string, unknown>>({ filter: "x" });

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, () => argsRef.value, { initialNumItems: NUM_ITEMS })))!;

        fake.push(
            "messages:list",
            { filter: "x", paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: "cur-1", isDone: false, page: firstPageItems },
        );
        await flushAsync();

        result.loadMore(NUM_ITEMS);
        await flushAsync();

        fake.push(
            "messages:list",
            { filter: "x", paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: null, isDone: true, page: secondPageItems },
        );
        await flushAsync();

        expect(result.results.value).toStrictEqual([...firstPageItems, ...secondPageItems]);

        const subscribeCountBefore = fake.subscribeCalls.length;

        // Replace with a brand-new object of equal content — identity differs but
        // the stable key does not, so the feed must NOT tear down to page one.
        argsRef.value = { filter: "x" };
        await flushAsync();

        expect(result.results.value).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(result.status.value).toBe("Exhausted");
        expect(fake.subscribeCalls).toHaveLength(subscribeCountBefore);

        scope.stop();
    });

    it("loadMore is re-entrancy safe: two synchronous calls do not duplicate the tail", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        fake.push(
            "messages:list",
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: "cur-1", isDone: false, page: firstPageItems },
        );
        await flushAsync();

        // Two synchronous loadMore calls before the next flush — the second sees
        // the same stale tail cursor and must be a no-op.
        result.loadMore(NUM_ITEMS);
        result.loadMore(NUM_ITEMS);
        await flushAsync();

        // Exactly one new tail subscription for cursor "cur-1" — not two, and no
        // degenerate empty (cur-1, cur-1] page.
        const tailArgs = JSON.stringify({ paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } });
        const tailSubs = fake.subscribeCalls.filter((call) => JSON.stringify(call.args) === tailArgs);

        expect(tailSubs).toHaveLength(1);

        fake.push(
            "messages:list",
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: null, isDone: true, page: secondPageItems },
        );
        await flushAsync();

        expect(result.results.value).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(result.status.value).toBe("Exhausted");

        scope.stop();
    });

    it("last page reports Exhausted", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        fake.push(
            "messages:list",
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(result.status.value).toBe("Exhausted");

        scope.stop();
    });

    it("does not open page subscriptions during SSR (no window)", async () => {
        const fake = createFakeClient();

        // Simulate the server render: no browser `window`.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => usePaginatedQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        await flushAsync();

        expect(fake.subscribeCalls).toHaveLength(0);
        expect(result.status.value).toBe("LoadingFirstPage");
        expect(result.results.value).toStrictEqual([]);

        scope.stop();
    });
});

describe("useInfiniteQuery (Vue)", () => {
    // `useInfiniteQuery` shares the same paginated core as `usePaginatedQuery`
    // (see that describe block above for the SSR-guard rationale).
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("first page loads as first page array", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => useInfiniteQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        expect(result.isLoading.value).toBe(true);
        expect(result.pages.value).toStrictEqual([]);

        fake.push(
            "messages:list",
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(result.isLoading.value).toBe(false);
        expect(result.hasNextPage.value).toBe(true);
        expect(result.pages.value).toStrictEqual([firstPageItems]);

        scope.stop();
    });

    it("fetchNextPage appends second page array", async () => {
        const fake = createFakeClient();

        const scope = effectScope();
        const result = scope.run(() => fake.provide(() => useInfiniteQuery(fn, {}, { initialNumItems: NUM_ITEMS })))!;

        // First page.
        fake.push(
            "messages:list",
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        result.fetchNextPage();
        await flushAsync();

        // Second page.
        fake.push(
            "messages:list",
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );
        await flushAsync();

        expect(result.pages.value).toStrictEqual([firstPageItems, secondPageItems]);
        expect(result.hasNextPage.value).toBe(false);

        scope.stop();
    });
});
