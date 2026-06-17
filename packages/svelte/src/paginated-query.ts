import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import type { Readable } from "svelte/store";
import { derived, readable, writable } from "svelte/store";

import { getLunoraClient } from "./context";

/** Narrow an unknown value to a {@link FunctionReference} by its `__lunoraRef` marker. */
const isFunctionReference = (value: unknown): value is FunctionReference =>
    typeof value === "object" && value !== null && typeof (value as { __lunoraRef?: unknown }).__lunoraRef === "string";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOf<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

interface PaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    shardKey?: string;
}

interface PaginatedQueryHandle<T> {
    /** `true` while the first page or a `loadMore` page is in flight. */
    isLoading: Readable<boolean>;
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Flattened items across every loaded page, in order. */
    results: Readable<T[]>;
    status: Readable<PaginationStatus>;
}

interface InfiniteQueryOptions {
    /** Page size for the first page (and the default for `fetchNextPage`). */
    initialNumItems: number;
    shardKey?: string;
}

interface InfiniteQueryHandle<T> {
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;
    /** `true` when the loaded tail reports it can load another page. */
    hasNextPage: Readable<boolean>;
    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    isFetchingNextPage: Readable<boolean>;
    /** `true` while the first page is in flight. */
    isLoading: Readable<boolean>;
    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    pages: Readable<T[][]>;
    status: Readable<PaginationStatus>;
}

const buildPageArgs = (page: Page, baseArgs: Record<string, unknown>): Record<string, unknown> => {
    return {
        ...baseArgs,
        paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems },
    };
};

const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${JSON.stringify(pageArgs)}`;

/**
 * Internal pagination engine. Manages page boundaries, subscriptions, results,
 * and split/join maintenance. Uses the Svelte lazy-readable pattern: subscriptions
 * are opened inside the `readable` start callback and torn down when the last
 * subscriber unsubscribes — exactly like `query.ts` does for plain queries.
 *
 * The `pendingPageKeys` set suppresses split/join rebalance while a freshly
 * loaded page is still awaiting its first result — matching Vue's policy so a
 * shrinking tail edit before `loadMore` resolves cannot silently undo the
 * loadMore via the JOIN branch.
 */
const createPaginatedEngine = <T>(
    client: LunoraClient,
    function_: FunctionReference,
    baseArgs: "skip" | Record<string, unknown>,
    options: { initialNumItems: number; shardKey?: string },
): {
    loadMore: (numberItems: number) => void;
    pageResults: Readable<(PaginationResult<T> | undefined)[]>;
    status: Readable<PaginationStatus>;
} => {
    const { initialNumItems, shardKey } = options;

    const pagesStore = writable<Page[]>(initialPages(initialNumItems));
    // pageResultsStore is a writable used as the source; pageResults is the
    // public Readable that the lazy start/stop callback wires up.
    const pageResultsInternal = writable<(PaginationResult<T> | undefined)[]>([]);

    const resultsByKey = new Map<string, PaginationResult<T>>();
    const activeSubs = new Map<string, Unsubscribe>();

    /**
     * Keys of pages that are still awaiting their first server result after a
     * `loadMore`. Rebalance is suppressed while this set is non-empty to prevent
     * the JOIN branch from merging a freshly appended page away before it resolves.
     */
    const pendingPageKeys = new Set<string>();

    let currentPages: Page[] = initialPages(initialNumItems);
    const currentBaseArgs: "skip" | Record<string, unknown> = baseArgs;

    // Track currentPages from the store so loadMore can read it synchronously.
    pagesStore.subscribe((pages) => {
        currentPages = pages;
    });

    const rebuildPageResults = (): void => {
        if (currentBaseArgs === "skip") {
            pageResultsInternal.set([]);

            return;
        }

        const updated = currentPages.map((page) => {
            const key = buildPageKey(function_["__lunoraRef"], buildPageArgs(page, currentBaseArgs));

            return resultsByKey.get(key);
        });

        pageResultsInternal.set(updated);
    };

    const syncSubscriptions = (): void => {
        if (currentBaseArgs === "skip") {
            for (const unsub of activeSubs.values()) {
                unsub();
            }

            activeSubs.clear();
            pageResultsInternal.set([]);

            return;
        }

        const baseArgsRecord = currentBaseArgs;
        const wantedKeys = new Set<string>();

        for (const page of currentPages) {
            wantedKeys.add(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgsRecord)));
        }

        // Close stale subscriptions.
        for (const [key, unsub] of activeSubs) {
            if (!wantedKeys.has(key)) {
                unsub();
                activeSubs.delete(key);
                pendingPageKeys.delete(key);
            }
        }

        // Open new subscriptions.
        for (const page of currentPages) {
            const pageArgs = buildPageArgs(page, baseArgsRecord);
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

                    rebuildPageResults();

                    // SPLIT/JOIN maintenance: only rebalance when no pages are still
                    // in their initial-load phase. A newly appended page (from
                    // `loadMore`) stays in `pendingPageKeys` until its first result
                    // arrives; joining before that would discard visible content.
                    if (pendingPageKeys.size === 0) {
                        let updatedResults: (PaginationResult<T> | undefined)[] = [];

                        pageResultsInternal.subscribe((results) => {
                            updatedResults = results;
                        })();

                        const next = rebalance(currentPages, updatedResults);

                        if (next) {
                            pagesStore.set(next);
                            syncSubscriptions();
                            rebuildPageResults();
                        }
                    }
                },
                { shardKey },
            );

            activeSubs.set(key, unsub);
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

    // pageResults is a lazy Svelte readable: subscriptions open on the first
    // $-read and close when the last subscriber unsubscribes — matching the
    // pattern used by `query.ts` so no WS handles leak after unmount.
    const pageResults: Readable<(PaginationResult<T> | undefined)[]> = readable<(PaginationResult<T> | undefined)[]>([], (set) => {
        // Wire internal store updates through to this readable's subscribers.
        const unsubInternal = pageResultsInternal.subscribe(set);

        // Eagerly open subscriptions now that someone is watching.
        if (currentBaseArgs !== "skip") {
            syncSubscriptions();
            rebuildPageResults();
        }

        return () => {
            unsubInternal();
            teardownAll();
            // Reset so a re-subscribe starts clean.
            pagesStore.set(initialPages(initialNumItems));
            pageResultsInternal.set([]);
        };
    });

    const status = derived<Readable<(PaginationResult<T> | undefined)[]>, PaginationStatus>(
        pageResults,
        (results) => derivePaginationStatus(currentBaseArgs === "skip", results).status,
    );

    const loadMore = (numberItems: number): void => {
        if (currentBaseArgs === "skip") {
            return;
        }

        let currentResults: (PaginationResult<T> | undefined)[] = [];

        pageResultsInternal.subscribe((results) => {
            currentResults = results;
        })();

        const { nextCursor, status: currentStatus } = derivePaginationStatus(false, currentResults);

        if (currentStatus !== "CanLoadMore") {
            return;
        }

        const next = applyLoadMore(currentPages, nextCursor, numberItems);

        if (!next) {
            return;
        }

        // `applyLoadMore` pins the open-ended tail: its args key changes from
        // `endCursor: null` to `endCursor: cursor`. Carry the existing result to
        // the new key before updating pages so `rebuildPageResults` does not lose
        // the first-page data when the pinned subscription re-opens.
        const oldTail = currentPages.at(-1);
        const newPinnedPage = next.at(-2); // applyLoadMore appends the new open tail last

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(oldTail, currentBaseArgs));
            const newKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(newPinnedPage, currentBaseArgs));

            if (oldKey !== newKey) {
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }

        pagesStore.set(next);
        syncSubscriptions();
        rebuildPageResults();
    };

    return { loadMore, pageResults, status };
};

/**
 * Open a live paginated query as Svelte stores. The first page opens when
 * called; call `loadMore(n)` to append the next page. Results are flattened
 * across all loaded pages.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
 */
export function paginatedQuery<F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArguments: F | "skip" | PaginatedArgs<F>,
    argumentsOrOptions: PaginatedQueryOptions | "skip" | PaginatedArgs<F>,
    maybeOptions?: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>> {
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as "skip" | PaginatedArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : argumentsOrOptions) as PaginatedQueryOptions;

    const { loadMore, pageResults, status } = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    const results = derived<Readable<(PaginationResult<PageItemOf<F>> | undefined)[]>, PageItemOf<F>[]>(pageResults, (currentResults) => {
        const items: PageItemOf<F>[] = [];

        for (const page of currentResults) {
            if (page) {
                items.push(...page.page);
            }
        }

        return items;
    });

    const isLoading = derived<Readable<PaginationStatus>, boolean>(
        status,
        (currentStatus) => currentStatus === "LoadingFirstPage" || currentStatus === "LoadingMore",
    );

    return { isLoading, loadMore, results, status };
}

/**
 * Open a live paginated query as Svelte stores, keeping each page as its own
 * inner array (TanStack-Query-style `fetchNextPage` / `hasNextPage` shape).
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
 */
export function infiniteQuery<F extends FunctionReference>(
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>>;
export function infiniteQuery<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: "skip" | PaginatedArgs<F>,
    options: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>>;
export function infiniteQuery<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArguments: F | "skip" | PaginatedArgs<F>,
    argumentsOrOptions: InfiniteQueryOptions | "skip" | PaginatedArgs<F>,
    maybeOptions?: InfiniteQueryOptions,
): InfiniteQueryHandle<PageItemOf<F>> {
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as "skip" | PaginatedArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : argumentsOrOptions) as InfiniteQueryOptions;
    const { initialNumItems } = options;

    const { loadMore, pageResults, status } = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    const pages = derived<Readable<(PaginationResult<PageItemOf<F>> | undefined)[]>, PageItemOf<F>[][]>(pageResults, (currentResults) => {
        const result: PageItemOf<F>[][] = [];

        for (const page of currentResults) {
            if (page) {
                result.push(page.page);
            }
        }

        return result;
    });

    const isLoading = derived<Readable<PaginationStatus>, boolean>(status, (s) => s === "LoadingFirstPage");
    const hasNextPage = derived<Readable<PaginationStatus>, boolean>(status, (s) => s === "CanLoadMore");
    const isFetchingNextPage = derived<Readable<PaginationStatus>, boolean>(status, (s) => s === "LoadingMore");

    const fetchNextPage = (numberItems?: number): void => {
        loadMore(numberItems ?? initialNumItems);
    };

    return { fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, pages, status };
}

export type { InfiniteQueryHandle, InfiniteQueryOptions, PageItemOf, PaginatedArgs, PaginatedQueryHandle, PaginatedQueryOptions };
