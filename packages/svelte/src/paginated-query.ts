import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import type { Readable } from "svelte/store";
import { derived, get, readable, writable } from "svelte/store";

import { isBrowser } from "../../../shared/is-browser";
import { stableWireKey } from "../../../shared/wire-key";
import { getLunoraClient } from "./context";
import { isFunctionReference } from "./is-function-reference";
import { isReadableStore } from "./is-readable-store";
import { subscribeReactiveArgs } from "./subscribe-reactive-args";

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOf<F>, "paginationOpts">;

/** Paginated args, the skip sentinel, or a reactive (`Readable`) source of either. */
type ReactivePaginatedArgs<F extends FunctionReference> = "skip" | PaginatedArgs<F> | Readable<"skip" | PaginatedArgs<F>>;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnOf<F> extends { page: (infer T)[] } ? T : unknown;

interface PaginatedQueryOptions {
    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;
    /** Called when a page subscription reports an error (also surfaced on the `error` store). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface PaginatedQueryHandle<T> {
    /**
     * The last page subscription error, or `undefined`. A tail page that fails
     * before its first frame is dropped so `status` returns to `"CanLoadMore"`
     * and `loadMore` can retry it; cleared by the next successful frame,
     * `loadMore`, or an args emission.
     */
    error: Readable<SubscriptionError | undefined>;
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
    /** Called when a page subscription reports an error (also surfaced on the `error` store). */
    onError?: SubscriptionErrorCallback;
    shardKey?: string;
}

interface InfiniteQueryHandle<T> {
    /** The last page subscription error, or `undefined` — see `PaginatedQueryHandle.error`. */
    error: Readable<SubscriptionError | undefined>;
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

// Key pages with the repo's canonical `stableWireKey` (keys sorted at every
// depth, wire-typed args tokenized) rather than raw `JSON.stringify`, so two
// structurally-equal arg records built with a different key order collapse to
// one key instead of opening a duplicate subscription — matching the client's
// own `SubscriptionRegistry.key`.
const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${stableWireKey(pageArgs)}`;

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
    baseArgs: "skip" | Record<string, unknown> | Readable<"skip" | Record<string, unknown>>,
    options: { initialNumItems: number; onError?: SubscriptionErrorCallback; shardKey?: string },
): {
    error: Readable<SubscriptionError | undefined>;
    loadMore: (numberItems: number) => void;
    pageResults: Readable<(PaginationResult<T> | undefined)[]>;
    /** Whether the currently-resolved base args are the `"skip"` sentinel. */
    skipped: Readable<boolean>;
    status: Readable<PaginationStatus>;
} => {
    const { initialNumItems, onError, shardKey } = options;

    const pagesStore = writable<Page[]>(initialPages(initialNumItems));
    const errorStore = writable<SubscriptionError | undefined>();
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

    // For a reactive args source this starts at `"skip"` and is replaced by the
    // store's first (synchronous) emission when `pageResults` gains a subscriber.
    let currentBaseArgs: "skip" | Record<string, unknown> = isReadableStore<"skip" | Record<string, unknown>>(baseArgs) ? "skip" : baseArgs;

    const rebuildPageResults = (): void => {
        if (currentBaseArgs === "skip") {
            pageResultsInternal.set([]);

            return;
        }

        const baseArgsRecord = currentBaseArgs;

        const updated = get(pagesStore).map((page) => {
            const key = buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgsRecord));

            return resultsByKey.get(key);
        });

        pageResultsInternal.set(updated);
    };

    /**
     * When `rebalance` splits or joins pages the per-page result keys change.
     * Carry the existing results to the new keys so visible data is preserved
     * while the server acknowledges the new boundary (a joined page seeds from
     * the lower of the merged pages; a split page seeds both halves from the
     * parent). Best-effort — the fresh subscription overwrites it once attached.
     *
     * Must run BEFORE `pagesStore.set(next)` / `syncSubscriptions()` so the new
     * keys are seeded before the stale-subscription sweep prunes the old ones.
     * Without this, `rebuildPageResults` emits `undefined` for the re-keyed
     * page(s) and the derived `results`/`pages` stores drop those items until
     * the new subscription's first frame arrives.
     */
    const migrateResultsForRebalance = (oldPages: Page[], newPages: Page[]): void => {
        if (currentBaseArgs === "skip") {
            return;
        }

        const baseArgsRecord = currentBaseArgs;
        const keyOf = (page: Page): string => buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgsRecord));

        for (const newPage of newPages) {
            const newKey = keyOf(newPage);

            if (resultsByKey.has(newKey)) {
                continue;
            }

            // The old page whose lower bound matches covers the start of this range.
            const donor = oldPages.find((op) => op.lower === newPage.lower);

            if (donor) {
                const carried = resultsByKey.get(keyOf(donor));

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }
    };

    const syncPass = (): void => {
        if (currentBaseArgs === "skip") {
            for (const unsub of activeSubs.values()) {
                unsub();
            }

            activeSubs.clear();
            pageResultsInternal.set([]);

            return;
        }

        const baseArgsRecord = currentBaseArgs;
        const pages = get(pagesStore);
        const wantedKeys = new Set<string>();

        for (const page of pages) {
            wantedKeys.add(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgsRecord)));
        }

        // Close stale subscriptions and drop their cached results so a later
        // re-key that reproduces a superseded key cannot resurrect stale data,
        // and the result map does not grow unboundedly across loadMore cycles.
        for (const [key, unsub] of activeSubs) {
            if (!wantedKeys.has(key)) {
                unsub();
                activeSubs.delete(key);
                pendingPageKeys.delete(key);
                resultsByKey.delete(key);
            }
        }

        // Open new subscriptions.
        for (const page of pages) {
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
                    errorStore.set(undefined);

                    rebuildPageResults();

                    // SPLIT/JOIN maintenance: only rebalance when no pages are still
                    // in their initial-load phase. A newly appended page (from
                    // `loadMore`) stays in `pendingPageKeys` until its first result
                    // arrives; joining before that would discard visible content.
                    if (pendingPageKeys.size === 0) {
                        const latestPages = get(pagesStore);
                        const next = rebalance(latestPages, get(pageResultsInternal));

                        if (next) {
                            // Carry results to the re-keyed pages before swapping the
                            // page list so the sweep in `syncSubscriptions` cannot drop
                            // visible items before the new subscription's first frame.
                            migrateResultsForRebalance(latestPages, next);
                            pagesStore.set(next);
                            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- runs inside a deferred subscription callback, after syncSubscriptions is defined
                            syncSubscriptions();
                            rebuildPageResults();
                        }
                    }
                },
                {
                    onError: (subscriptionError) => {
                        pendingPageKeys.delete(key);
                        errorStore.set(subscriptionError);

                        // A tail that fails before its first frame is dropped so
                        // the feed leaves `LoadingMore` (status falls back to the
                        // previous page's cursor) and `loadMore` can retry it. The
                        // first page has nothing to fall back to and stays.
                        const current = get(pagesStore);
                        const tail = current.at(-1);

                        if (
                            current.length > 1 &&
                            tail &&
                            !resultsByKey.has(key) &&
                            buildPageKey(function_["__lunoraRef"], buildPageArgs(tail, baseArgsRecord)) === key
                        ) {
                            pagesStore.set(current.slice(0, -1));
                            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- runs inside a deferred subscription callback, after syncSubscriptions is defined
                            syncSubscriptions();
                            rebuildPageResults();
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
    // empties `pendingPageKeys` and `rebalance` returns a new layout, the callback
    // re-enters `syncSubscriptions` against half-populated bookkeeping. Re-entering
    // the open loop there would duplicate still-wanted subs and orphan handles (the
    // outer frame's `activeSubs.set` overwrites the reentrant entry) — a leaked,
    // unsubscribable WS subscription. So guard: while a pass is running, a nested
    // call only flags a re-sync, which the drain below runs once the outer pass has
    // finished recording every handle — that follow-up pass closes any now-stale
    // sub and opens the genuinely new pages against complete bookkeeping.
    let syncing = false;
    let resyncRequested = false;

    const syncSubscriptions = (): void => {
        if (syncing) {
            resyncRequested = true;

            return;
        }

        syncing = true;

        try {
            do {
                resyncRequested = false;
                syncPass();
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

    // pageResults is a lazy Svelte readable: subscriptions open on the first
    // browser-side $-read and close when the last subscriber unsubscribes —
    // matching the pattern used by `query.ts` so no WS handles leak after
    // unmount and a server render opens nothing.
    const pageResults: Readable<(PaginationResult<T> | undefined)[]> = readable<(PaginationResult<T> | undefined)[]>([], (set) => {
        // Server-render guard: svelte's server runtime subscribes to `{$store}`
        // during `render()`, so this start callback runs on the server too. See
        // `query.ts` for why opening there is wrong (and, on a relative-URL
        // client, throws out of the render).
        if (!isBrowser()) {
            return () => {};
        }

        // Wire internal store updates through to this readable's subscribers.
        const unsubInternal = pageResultsInternal.subscribe(set);

        // Open the page subscriptions now that someone is watching. With a
        // reactive args source every emission is a full teardown + fresh
        // construction — the teardown resets pagination to the first page, so a
        // new emission builds exactly as if the engine were new.
        const stopArgs = subscribeReactiveArgs<"skip" | Record<string, unknown>>(baseArgs, (resolved) => {
            currentBaseArgs = resolved;
            syncSubscriptions();
            rebuildPageResults();

            return () => {
                teardownAll();
                pagesStore.set(initialPages(initialNumItems));
                errorStore.set(undefined);
            };
        });

        return () => {
            stopArgs();
            unsubInternal();
            pageResultsInternal.set([]);
        };
    });

    const status = derived<Readable<(PaginationResult<T> | undefined)[]>, PaginationStatus>(
        pageResults,
        (results) => derivePaginationStatus(currentBaseArgs === "skip", results).status,
    );

    // A skipped feed reports `status === "LoadingFirstPage"` (it has no first
    // page and never will), so `isLoading` must not derive from `status` alone —
    // it would spin forever. Piggyback on `pageResults` the way `status` does so
    // a reactive args source that flips to/from `"skip"` re-evaluates.
    const skipped = derived<Readable<(PaginationResult<T> | undefined)[]>, boolean>(pageResults, () => currentBaseArgs === "skip");

    const loadMore = (numberItems: number): void => {
        if (currentBaseArgs === "skip") {
            return;
        }

        const currentResults = get(pageResultsInternal);

        const { nextCursor, status: currentStatus } = derivePaginationStatus(false, currentResults);

        if (currentStatus !== "CanLoadMore") {
            return;
        }

        const currentPages = get(pagesStore);
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
                    // Drop the superseded open-tail entry so a later JOIN that
                    // reproduces this key cannot serve the pre-loadMore result.
                    resultsByKey.delete(oldKey);
                }
            }
        }

        errorStore.set(undefined);
        pagesStore.set(next);
        syncSubscriptions();
        rebuildPageResults();
    };

    return { error: { subscribe: errorStore.subscribe }, loadMore, pageResults, skipped, status };
};

/**
 * Open a live paginated query as Svelte stores. The first page opens when
 * called; call `loadMore(n)` to append the next page. Results are flattened
 * across all loaded pages.
 *
 * Pass `client` explicitly, or omit it to resolve the ambient client from the
 * Svelte context.
 *
 * `args` may also be a `Readable` store: each emission tears the engine down
 * and rebuilds it against the new args (pagination resets to the first page);
 * a `"skip"` emission tears down without re-opening.
 */
export function paginatedQuery<F extends FunctionReference>(
    function_: F,
    args: ReactivePaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    client: LunoraClient,
    function_: F,
    args: ReactivePaginatedArgs<F>,
    options: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>>;
export function paginatedQuery<F extends FunctionReference>(
    clientOrFunction: F | LunoraClient,
    functionOrArguments: F | ReactivePaginatedArgs<F>,
    argumentsOrOptions: PaginatedQueryOptions | ReactivePaginatedArgs<F>,
    maybeOptions?: PaginatedQueryOptions,
): PaginatedQueryHandle<PageItemOf<F>> {
    const hasExplicitClient = !isFunctionReference(clientOrFunction);
    const client = hasExplicitClient ? clientOrFunction : getLunoraClient();
    const functionRef = (hasExplicitClient ? functionOrArguments : clientOrFunction) as F;
    const args = (hasExplicitClient ? argumentsOrOptions : functionOrArguments) as ReactivePaginatedArgs<F>;
    const options = (hasExplicitClient ? maybeOptions : argumentsOrOptions) as PaginatedQueryOptions;

    const { error, loadMore, pageResults, skipped, status } = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    const results = derived<Readable<(PaginationResult<PageItemOf<F>> | undefined)[]>, PageItemOf<F>[]>(pageResults, (currentResults) =>
        currentResults.flatMap((page) => page?.page ?? []),
    );

    const isLoading = derived(
        [status, skipped],
        ([currentStatus, isSkipped]) => !isSkipped && (currentStatus === "LoadingFirstPage" || currentStatus === "LoadingMore"),
    );

    return { error, isLoading, loadMore, results, status };
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

    const { error, loadMore, pageResults, skipped, status } = createPaginatedEngine<PageItemOf<F>>(client, functionRef, args, options);

    const pages = derived<Readable<(PaginationResult<PageItemOf<F>> | undefined)[]>, PageItemOf<F>[][]>(pageResults, (currentResults) =>
        currentResults.flatMap((page) => (page ? [page.page] : [])),
    );

    const isLoading = derived([status, skipped], ([s, isSkipped]) => !isSkipped && s === "LoadingFirstPage");
    const hasNextPage = derived<Readable<PaginationStatus>, boolean>(status, (s) => s === "CanLoadMore");
    const isFetchingNextPage = derived([status, skipped], ([s, isSkipped]) => !isSkipped && s === "LoadingMore");

    const fetchNextPage = (numberItems?: number): void => {
        loadMore(numberItems ?? initialNumItems);
    };

    return { error, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, pages, status };
}

export type { InfiniteQueryHandle, InfiniteQueryOptions, PageItemOf, PaginatedArgs, PaginatedQueryHandle, PaginatedQueryOptions, ReactivePaginatedArgs };
