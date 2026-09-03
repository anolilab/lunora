import type { ArgsOf, FunctionReference, ReturnOf, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import type { Accessor } from "solid-js";
import { createMemo, createSignal } from "solid-js";

import { stableWireKey } from "../../../shared/wire-key";
import { useLunora } from "./context";
import { trackedEffect } from "./solid-compat";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

interface CreatePaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    /** Called when a page subscription reports an error (also surfaced on the `error` accessor). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface CreatePaginatedQueryResult<T> {
    /**
     * The last page subscription error, or `undefined`. A tail page that fails
     * before its first frame is dropped so `status` returns to `"CanLoadMore"`
     * and `loadMore` can retry it; cleared by the next successful frame,
     * `loadMore`, or an args change.
     */
    error: Accessor<SubscriptionError | undefined>;
    /** `true` while the first page or a `loadMore` page is in flight. */
    isLoading: Accessor<boolean>;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Flattened items across every loaded page, in order. */
    results: Accessor<T[]>;
    status: Accessor<PaginationStatus>;
}

interface CreateInfiniteQueryOptions {
    /** Page size for the first page (and the default for `fetchNextPage`). */
    initialNumItems: number;
    /** Called when a page subscription reports an error (also surfaced on the `error` accessor). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface CreateInfiniteQueryResult<T> {
    /** The last page subscription error, or `undefined` — see `CreatePaginatedQueryResult.error`. */
    error: Accessor<SubscriptionError | undefined>;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;
    /** `true` when the loaded tail reports it can load another page. */
    hasNextPage: Accessor<boolean>;
    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    isFetchingNextPage: Accessor<boolean>;
    /** `true` while the first page is in flight. */
    isLoading: Accessor<boolean>;
    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    pages: Accessor<T[][]>;
    status: Accessor<PaginationStatus>;
}

const buildPageArgs = (page: Page, baseArgs: Record<string, unknown>): Record<string, unknown> => {
    return {
        ...baseArgs,
        paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems },
    };
};

// Key pages with the repo's canonical `stableWireKey` (keys sorted at every
// depth, wire-typed args tokenized) rather than raw `JSON.stringify`, so two
// structurally-equal arg records built with a different key order collapse to
// one key instead of opening a duplicate subscription — matching the client's
// own `SubscriptionRegistry.key`.
const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${stableWireKey(pageArgs)}`;

/**
 * SolidJS-native pagination engine shared by `createPaginatedQuery` and
 * `createInfiniteQuery`. Owns the page boundary list, per-page
 * `client.subscribe()` calls, split/join maintenance, and `loadMore`.
 *
 * Cursor logic lives entirely in `@lunora/client/pagination`; this file only
 * adds the reactive SolidJS glue.
 */
const createPaginatedCore = <T>(
    function_: FunctionReference,
    args: "skip" | Accessor<"skip" | Record<string, unknown>> | Record<string, unknown>,
    options: { initialNumItems: number; onError?: SubscriptionErrorCallback; shardKey?: string },
): {
    error: Accessor<SubscriptionError | undefined>;
    loadMore: (n: number) => void;
    pageResults: Accessor<(PaginationResult<T> | undefined)[]>;
    status: Accessor<PaginationStatus>;
} => {
    const client = useLunora();
    const { initialNumItems, onError, shardKey } = options;

    const resolveArgs = (): "skip" | Record<string, unknown> => (typeof args === "function" ? args() : args);

    const [pages, setPages] = createSignal<Page[]>(initialPages(initialNumItems));

    // Keyed result store: pageKey → result.
    const resultsByKey = new Map<string, PaginationResult<T>>();

    const [pageResults, setPageResults] = createSignal<(PaginationResult<T> | undefined)[]>([]);
    const [error, setError] = createSignal<SubscriptionError | undefined>(undefined);

    // Active subscriptions keyed by pageKey.
    const activeSubs = new Map<string, Unsubscribe>();

    /**
     * Keys of pages that are still awaiting their first server result after a
     * `loadMore`. Rebalance is suppressed while this set is non-empty to prevent
     * the JOIN branch from merging a freshly appended page away before it resolves —
     * matching Vue's `pendingPageKeys` policy (see `use-paginated-core.ts`).
     */
    const pendingPageKeys = new Set<string>();

    const rebuildPageResults = (currentPages: Page[], baseArgs: Record<string, unknown>): void => {
        const updated = currentPages.map((page) => {
            const key = buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs));

            return resultsByKey.get(key);
        });

        setPageResults(updated);
    };

    /**
     * When rebalance splits or joins pages, the result keys change. Carry the
     * existing results to the new keys so visible data is preserved while the
     * server acknowledges the new boundary; each new page seeds its result from
     * the old page whose `lower` bound matches (the page covering the start of
     * the new range). Best-effort — the server sends a fresh result on the new
     * subscription once attached. Mirrors Vue's `migrateResultsForRebalance`.
     */
    const migrateResultsForRebalance = (oldPages: Page[], newPages: Page[], baseArgs: Record<string, unknown>): void => {
        const keyOf = (page: Page): string => buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs));

        for (const newPage of newPages) {
            const newKey = keyOf(newPage);

            if (resultsByKey.has(newKey)) {
                continue; // already have a fresh result under this key
            }

            const donor = oldPages.find((oldPage) => oldPage.lower === newPage.lower);

            if (donor) {
                const carried = resultsByKey.get(keyOf(donor));

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }
    };

    const syncPass = (currentPages: Page[], baseArgs: Record<string, unknown>): void => {
        const wantedKeys = new Set<string>();

        for (const page of currentPages) {
            wantedKeys.add(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs)));
        }

        // Close stale subscriptions and reclaim their stored results. Any key not
        // in `wantedKeys` no longer maps to a current page, so its `resultsByKey`
        // entry (a full page array) would otherwise be stranded forever — one leak
        // per `loadMore`/rebalance over a long-lived feed. `loadMore`'s tail carry
        // and `migrateResultsForRebalance` copy the result to the new key before
        // the pages change, so the entry is safe to drop here.
        for (const [key, unsub] of activeSubs) {
            if (!wantedKeys.has(key)) {
                unsub();
                activeSubs.delete(key);
                pendingPageKeys.delete(key);
                resultsByKey.delete(key);
            }
        }

        // Open new subscriptions.
        for (const page of currentPages) {
            const pageArgs = buildPageArgs(page, baseArgs);
            const key = buildPageKey(function_["__lunoraRef"], pageArgs);

            if (activeSubs.has(key)) {
                continue;
            }

            // Mark this page as pending until its first result arrives.
            pendingPageKeys.add(key);

            const unsub = client.subscribe(
                function_,
                pageArgs,
                (value) => {
                    resultsByKey.set(key, value as PaginationResult<T>);

                    // This page has resolved; remove from the pending set.
                    pendingPageKeys.delete(key);
                    setError(undefined);

                    const currentArgs = resolveArgs();

                    if (currentArgs === "skip") {
                        return;
                    }

                    rebuildPageResults(pages(), currentArgs);

                    // SPLIT/JOIN maintenance: only rebalance when no pages are still
                    // awaiting their first result. A newly appended page (from
                    // `loadMore`) stays in `pendingPageKeys` until it resolves;
                    // joining before that would discard visible content.
                    if (pendingPageKeys.size === 0) {
                        const latestPages = pages();
                        const next = rebalance(latestPages, pageResults());

                        if (next) {
                            // Seed the new page keys from the old results before
                            // swapping `pages`, so already-rendered items don't
                            // vanish (and the status regress to LoadingFirstPage)
                            // until the new subscriptions' first frames arrive.
                            migrateResultsForRebalance(latestPages, next, currentArgs);
                            setPages(next);
                        }
                    }
                },
                {
                    onError: (subscriptionError) => {
                        pendingPageKeys.delete(key);
                        setError(subscriptionError);

                        // A tail that fails before its first frame is dropped so
                        // the feed leaves `LoadingMore` (status falls back to the
                        // previous page's cursor) and `loadMore` can retry it. The
                        // first page has nothing to fall back to and stays.
                        const current = pages();
                        const tail = current.at(-1);

                        if (
                            current.length > 1 &&
                            tail &&
                            !resultsByKey.has(key) &&
                            buildPageKey(function_["__lunoraRef"], buildPageArgs(tail, baseArgs)) === key
                        ) {
                            setPages(current.slice(0, -1));
                        }

                        onError?.(subscriptionError);
                    },
                    shardKey,
                },
            );

            activeSubs.set(key, unsub);
        }
    };

    // `client.subscribe` replays a cached value to the new subscriber
    // SYNCHRONOUSLY — the callback fires before `subscribe` returns, i.e. before
    // this page's `activeSubs.set(key, unsub)` above is recorded. If that replay
    // empties `pendingPageKeys` and `rebalance` returns a new layout, `setPages`
    // updates the `pages` signal, and the `pages` effect below can re-enter
    // `syncSubscriptions` against half-populated bookkeeping (depending on whether
    // Solid schedules that effect synchronously in this construction). Re-entering
    // the open loop there would duplicate still-wanted subs and orphan handles (the
    // outer frame's `activeSubs.set` overwrites the reentrant entry) — a leaked,
    // unsubscribable WS subscription. So guard: while a pass is running, a nested
    // call only flags a re-sync, which the drain below runs once the outer pass has
    // finished recording every handle — that follow-up pass closes any now-stale
    // sub and opens the genuinely new pages against complete bookkeeping. Safe even
    // if Solid already defers the effect (then this is a no-op hardening).
    let syncing = false;
    let resyncRequested = false;

    const syncSubscriptions = (currentPages: Page[], baseArgs: Record<string, unknown>): void => {
        if (syncing) {
            resyncRequested = true;

            return;
        }

        syncing = true;

        try {
            let pagesToSync = currentPages;
            let argsToSync = baseArgs;

            do {
                resyncRequested = false;
                syncPass(pagesToSync, argsToSync);

                const latestArgs = resolveArgs();

                if (latestArgs === "skip") {
                    break;
                }

                pagesToSync = pages();
                argsToSync = latestArgs;
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- resyncRequested is set by syncPass through a nested call the flow analyzer cannot track
            } while (resyncRequested);
        } finally {
            syncing = false;
        }
    };

    const teardownAll = (): void => {
        for (const unsub of activeSubs.values()) {
            unsub();
        }

        activeSubs.clear();
        resultsByKey.clear();
        pendingPageKeys.clear();
    };

    // Re-subscribe whenever the base args (or skip) change.
    trackedEffect(resolveArgs, (current) => {
        teardownAll();
        setPages(initialPages(initialNumItems));
        setPageResults([]);
        setError(undefined);

        if (current !== "skip") {
            syncSubscriptions(pages(), current);
            rebuildPageResults(pages(), current);
        }

        return teardownAll;
    });

    // Re-sync subscriptions whenever `pages` change (loadMore or rebalance).
    trackedEffect(pages, (currentPages) => {
        const current = resolveArgs();

        if (current !== "skip") {
            syncSubscriptions(currentPages, current);
            rebuildPageResults(currentPages, current);
        }
    });

    const status = createMemo<PaginationStatus>(() => {
        const skipped = resolveArgs() === "skip";

        return derivePaginationStatus(skipped, pageResults()).status;
    });

    const loadMore = (numberItems: number): void => {
        const current = resolveArgs();

        if (current === "skip") {
            return;
        }

        const { nextCursor, status: currentStatus } = derivePaginationStatus(false, pageResults());

        if (currentStatus !== "CanLoadMore") {
            return;
        }

        const next = applyLoadMore(pages(), nextCursor, numberItems);

        if (!next) {
            return;
        }

        // `applyLoadMore` pins the open-ended tail: its args key changes from
        // `endCursor: null` to `endCursor: cursor`. Carry the existing result to
        // the new key so `rebuildPageResults` after the pages update does not
        // lose the data. Unlike Vue (which re-keys the live subscription entry in
        // place), the Solid engine keys `activeSubs` by page key: the pages effect
        // runs `syncSubscriptions`, which closes the old tail's subscription and
        // opens a fresh one for the pinned page — and prunes the old key from
        // `resultsByKey` after this carry has copied it.
        const oldTail = pages().at(-1);
        const newPinnedPage = next.at(-2); // `applyLoadMore` inserts the new tail last

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(oldTail, current));
            const newKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(newPinnedPage, current));

            if (oldKey !== newKey) {
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
                // Keep oldKey in resultsByKey momentarily; syncSubscriptions
                // will close the old sub and delete the old key.
            }
        }

        setError(undefined);
        setPages(next);
    };

    return { error, loadMore, pageResults, status };
};

/**
 * Subscribe to a reactively-paginated query and grow the feed page by page.
 *
 * The query function must accept a `paginationOpts: { numItems, cursor,
 * endCursor }` arg and return a `PaginationResult`. `loadMore` appends the next
 * page off the open-ended tail's `continueCursor`; it is a no-op unless
 * `status === "CanLoadMore"`.
 *
 * Call inside a reactive context (component / `createRoot`).
 */
const createPaginatedQuery = <F extends FunctionReference>(
    function_: F,
    args: "skip" | Accessor<"skip" | PaginatedArgs<F>> | PaginatedArgs<F>,
    options: CreatePaginatedQueryOptions,
): CreatePaginatedQueryResult<PageItemOf<F>> => {
    const { error, loadMore, pageResults, status } = createPaginatedCore<PageItemOf<F>>(function_, args, options);

    const results = createMemo<PageItemOf<F>[]>(() => pageResults().flatMap((page) => page?.page ?? []));

    const isLoading = createMemo<boolean>(() => status() === "LoadingFirstPage" || status() === "LoadingMore");

    return { error, isLoading, loadMore, results, status };
};

/**
 * Subscribe to a reactively-paginated query and expose its pages discretely.
 *
 * Shares `createPaginatedQuery`'s pagination engine but keeps each page as its
 * own inner array (TanStack-Query-style `fetchNextPage` / `hasNextPage` shape).
 *
 * Call inside a reactive context (component / `createRoot`).
 */
const createInfiniteQuery = <F extends FunctionReference>(
    function_: F,
    args: "skip" | Accessor<"skip" | PaginatedArgs<F>> | PaginatedArgs<F>,
    options: CreateInfiniteQueryOptions,
): CreateInfiniteQueryResult<PageItemOf<F>> => {
    const { initialNumItems } = options;
    const { error, loadMore, pageResults, status } = createPaginatedCore<PageItemOf<F>>(function_, args, options);

    const pages = createMemo<PageItemOf<F>[][]>(() => pageResults().flatMap((page) => (page ? [page.page] : [])));

    const isLoading = createMemo<boolean>(() => status() === "LoadingFirstPage");
    const hasNextPage = createMemo<boolean>(() => status() === "CanLoadMore");
    const isFetchingNextPage = createMemo<boolean>(() => status() === "LoadingMore");

    const fetchNextPage = (numberItems?: number): void => {
        loadMore(numberItems ?? initialNumItems);
    };

    return { error, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, pages, status };
};

export type { CreateInfiniteQueryOptions, CreateInfiniteQueryResult, CreatePaginatedQueryOptions, CreatePaginatedQueryResult, PageItemOf, PaginatedArgs };
export { createInfiniteQuery, createPaginatedQuery };
