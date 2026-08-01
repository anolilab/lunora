import type { Signal } from "@angular/core";
import { computed, DestroyRef, inject, signal } from "@angular/core";
import type { FunctionReference, LunoraClient, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";

import { stableWireKey } from "../../../shared/wire-key";
import { resolveLunoraClient } from "./client";
import { shouldOpenSubscription } from "./platform";

// ── Shared types ────────────────────────────────────────────────────────────

/** The args a paginated query exposes minus the framework-supplied page cursor. */
type PaginatedArgs<F extends FunctionReference> = Omit<ArgsOfRaw<F>, "paginationOpts">;

/** The element type of the `page` array a paginated query returns. */
type PageItemOf<F extends FunctionReference> = ReturnTypeOf<F> extends { page: (infer T)[] } ? T : unknown;

// Simplified helper types that don't pull in the full Lunora client type machinery.
type ArgsOfRaw<F extends FunctionReference> = F extends FunctionReference<"query", infer A> ? A : never;
type ReturnTypeOf<F extends FunctionReference> = F extends FunctionReference<"query", unknown, infer R> ? R : never;

// ── Page key helpers ────────────────────────────────────────────────────────

// Key pages with the repo's canonical `stableWireKey` (keys sorted at every
// depth, wire-typed args tokenized) rather than raw `JSON.stringify`, so two
// structurally-equal arg records built with a different key order collapse to
// one key instead of opening a duplicate subscription — matching the client's
// own `SubscriptionRegistry.key`.
const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${stableWireKey(pageArgs)}`;

const buildPageArgs = (page: Page, baseArgs: Record<string, unknown>): Record<string, unknown> => {
    return {
        ...baseArgs,
        paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems },
    };
};

// ── Core pagination engine ──────────────────────────────────────────────────

/**
 * Angular-native pagination engine shared by `paginatedQuery` and `infiniteQuery`.
 * Owns the page boundary list, per-page `client.subscribe()` calls, split/join
 * maintenance, and `loadMore`.
 */
const usePaginatedCore = <F extends FunctionReference>(
    reference: F,
    baseArgs: Record<string, unknown> | "skip",
    options: PaginatedQueryOptions,
): {
    loadMore: (numberItems: number) => void;
    pageResults: Signal<(PaginationResult<PageItemOf<F>> | undefined)[]>;
    status: Signal<PaginationStatus>;
} => {
    const client = resolveLunoraClient(options.client);
    const fromInjectionContext = options.destroyRef === undefined;
    const destroyRef = options.destroyRef ?? inject(DestroyRef);
    const { initialNumItems, shardKey } = options;

    const functionPath = (reference as Record<string, unknown>)["__lunoraRef"] as string;

    // Narrow the union type so buildPageArgs' callees don't error — all call
    // sites are guarded by baseArgs !== "skip" before they reach here.
    const narrowedArgs = baseArgs === "skip" ? ({} as Record<string, unknown>) : baseArgs;

    const pages = signal<Page[]>(initialPages(initialNumItems));
    const pageResults = signal<(PaginationResult<PageItemOf<F>> | undefined)[]>([]);
    const status = signal<PaginationStatus>("LoadingFirstPage");

    /**
     * Each active subscription entry, keyed in `activeSubs` by the page key it
     * was opened under. `loadMore` re-keys a pinned page by closing the old
     * subscription and opening a fresh one (see below), so `currentKey` is set
     * once at creation and only read thereafter — never reassigned in place.
     */
    interface SubEntry {
        currentKey: string;
        unsub: Unsubscribe;
    }

    const activeSubs = new Map<string, SubEntry>();
    const resultsByKey = new Map<string, PaginationResult<PageItemOf<F>>>();
    const pendingPageKeys = new Set<string>();

    const doRebuildPageResults = (): void => {
        const currentPages = pages();
        const items = currentPages.map((page) => {
            const key = buildPageKey(functionPath, buildPageArgs(page, narrowedArgs));
            return resultsByKey.get(key);
        });
        pageResults.set(items);

        // Derive pagination status from the results.
        const { status: derivedStatus } = derivePaginationStatus(baseArgs === "skip", items);
        status.set(derivedStatus);
    };

    /**
     * When rebalance splits or joins pages, the result keys change. Carry existing
     * results to the new keys so visible data is preserved.
     */
    const migrateResultsForRebalance = (oldPages: Page[], newPages: Page[]): void => {
        const keyOf = (page: Page): string => buildPageKey(functionPath, buildPageArgs(page, narrowedArgs));

        for (const newPage of newPages) {
            const newKey = keyOf(newPage);

            if (resultsByKey.has(newKey)) {
                continue;
            }

            const donor = oldPages.find((op) => op.lower === newPage.lower);

            if (donor) {
                const carried = resultsByKey.get(keyOf(donor));

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }
    };

    const syncPass = (currentPages: Page[]): void => {
        const wantedKeys = new Set<string>();

        for (const page of currentPages) {
            wantedKeys.add(buildPageKey(functionPath, buildPageArgs(page, narrowedArgs)));
        }

        // Close stale subscriptions.
        for (const [originalKey, entry] of activeSubs) {
            if (!wantedKeys.has(entry.currentKey)) {
                entry.unsub();
                activeSubs.delete(originalKey);
                resultsByKey.delete(entry.currentKey);
            }
        }

        // Open new subscriptions for pages that have no active sub.
        const coveredKeys = new Set([...activeSubs.values()].map((subEntry) => subEntry.currentKey));

        for (const page of currentPages) {
            const pageArgs = buildPageArgs(page, narrowedArgs);
            const key = buildPageKey(functionPath, pageArgs);

            if (coveredKeys.has(key)) {
                continue;
            }

            const entry: SubEntry = {
                currentKey: key,
                unsub: undefined as unknown as Unsubscribe,
            };

            pendingPageKeys.add(key);

            const unsub = client.subscribe(
                reference,
                pageArgs as never,
                (value) => {
                    resultsByKey.set(entry.currentKey, value as PaginationResult<PageItemOf<F>>);
                    pendingPageKeys.delete(entry.currentKey);

                    doRebuildPageResults();

                    // Rebalance only when no pages are still in their initial-load phase.
                    if (pendingPageKeys.size === 0) {
                        const latestPages = pages();
                        const next = rebalance(latestPages, pageResults());

                        if (next) {
                            migrateResultsForRebalance(latestPages, next);
                            pages.set(next);
                            // eslint-disable-next-line @typescript-eslint/no-use-before-define -- runs inside a deferred subscription callback, after syncSubscriptions is defined
                            syncSubscriptions(next);
                            doRebuildPageResults();
                        }
                    }
                },
                {
                    onError: () => {
                        pendingPageKeys.delete(entry.currentKey);
                        doRebuildPageResults();
                    },
                    shardKey,
                },
            );

            entry.unsub = unsub;
            activeSubs.set(key, entry);
            coveredKeys.add(key);
        }
    };

    // `client.subscribe` replays a cached value to the new subscriber
    // SYNCHRONOUSLY — the callback fires before `subscribe` returns, i.e. before
    // the entry's `unsub` handle and `activeSubs` slot above are set. If that
    // replay empties `pendingPageKeys` and `rebalance` returns a new layout, the
    // callback re-enters `syncSubscriptions` against half-populated bookkeeping.
    // Re-entering the open loop there would duplicate still-wanted subs and orphan
    // handles (the outer frame's `activeSubs.set` overwrites the reentrant entry).
    // So guard: while a pass is running, a nested call only flags a re-sync, which
    // the drain below runs once the outer pass has finished recording every handle
    // — that follow-up pass closes any now-stale sub and opens the genuinely new
    // pages against complete bookkeeping.
    let syncing = false;
    let resyncRequested: boolean = false;

    const syncSubscriptions = (currentPages: Page[]): void => {
        if (syncing) {
            resyncRequested = true;

            return;
        }

        syncing = true;

        try {
            let pagesToSync = currentPages;

            do {
                resyncRequested = false;
                syncPass(pagesToSync);
                pagesToSync = pages();
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- resyncRequested is set by syncPass through a nested call the flow analyzer cannot track
            } while (resyncRequested);
        } finally {
            syncing = false;
        }
    };

    // The `shouldOpenSubscription()` guard skips all page subscriptions on the
    // Angular server platform (SSR); the browser render re-runs this and attaches.
    if (baseArgs !== "skip" && shouldOpenSubscription(fromInjectionContext)) {
        syncSubscriptions(pages());
    }

    doRebuildPageResults();

    // Teardown all subscriptions on destroy.
    destroyRef.onDestroy(() => {
        for (const entry of activeSubs.values()) {
            entry.unsub();
        }

        activeSubs.clear();
        resultsByKey.clear();
    });

    const loadMore = (numberItems: number): void => {
        if (baseArgs === "skip") {
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

        // `applyLoadMore` pins the open-ended tail: the last page's args shift
        // from `endCursor: null` to `endCursor: cursor`. Close the old
        // subscription, carry the result to the new key, and let
        // `syncSubscriptions` open a fresh sub for the pinned page.
        const oldTail = pages().at(-1);
        const newPinnedPage = next.at(-2);

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(functionPath, buildPageArgs(oldTail, narrowedArgs));
            const newKey = buildPageKey(functionPath, buildPageArgs(newPinnedPage, narrowedArgs));
            const entry = activeSubs.get(oldKey);

            if (entry && oldKey !== newKey) {
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }

                entry.unsub();
                activeSubs.delete(oldKey);
                resultsByKey.delete(oldKey);
            }
        }

        pages.set(next);
        syncSubscriptions(pages());
        doRebuildPageResults();
    };

    return { loadMore, pageResults, status };
};

// ── Paginated query options & result ────────────────────────────────────────

/**
 * Options for the paginated query — part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface PaginatedQueryOptions {
    /** Client to bind to. Defaults to the injected `LUNORA_CLIENT`. */
    client?: LunoraClient;

    /** `DestroyRef` whose `onDestroy` tears down the subscriptions. Defaults to `inject(DestroyRef)`. */
    destroyRef?: DestroyRef;

    /** Page size for the first page (and the default for `loadMore`). */
    initialNumItems: number;

    /** Route to a specific shard when the target function is `.shardBy(...)`-partitioned. */
    shardKey?: string;
}

/**
 * `PaginatedQueryResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface PaginatedQueryResult<T> {
    /** `true` while the first page or a `loadMore` page is in flight. */
    isLoading: Signal<boolean>;

    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;

    /** Flattened items across every loaded page, in order. */
    results: Signal<T[]>;

    /** The pagination status. */
    status: Signal<PaginationStatus>;
}

/**
 * `InfiniteQueryResult` is part of the experimental `@lunora/angular` API and may change without a major version bump.
 * @experimental
 */
export interface InfiniteQueryResult<T> {
    /** Request the next page. A no-op unless `status === "CanLoadMore"`. */
    fetchNextPage: (numberItems?: number) => void;

    /** `true` when the loaded tail reports it can load another page. */
    hasNextPage: Signal<boolean>;

    /** `true` while a `fetchNextPage` page (beyond the first) is in flight. */
    isFetchingNextPage: Signal<boolean>;

    /** `true` while the first page is in flight. */
    isLoading: Signal<boolean>;

    /** One inner array per loaded page, in order; unresolved pages are omitted. */
    pages: Signal<T[][]>;

    /** The pagination status. */
    status: Signal<PaginationStatus>;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Subscribe to a reactively-paginated query and grow the feed page by page.
 *
 * The query function must accept a `paginationOpts: { numItems, cursor,
 * endCursor }` arg and return a `PaginationResult`. Pages are tracked as an
 * ordered list of stable boundary cursors; each loaded page is a live
 * subscription over a FIXED `(lower, upper]` range.
 *
 * `loadMore` appends the next page off the open-ended tail's `continueCursor`;
 * it is a no-op unless `status === "CanLoadMore"`.
 *
 * Call from an injection context:
 * ```ts
 * readonly messages = paginatedQuery(api.messages.list, {}, { initialNumItems: 20 });
 * ```
 * @experimental
 */
export const paginatedQuery = <F extends FunctionReference>(
    reference: F,
    args: PaginatedArgs<F> | "skip",
    options: PaginatedQueryOptions,
): PaginatedQueryResult<PageItemOf<F>> => {
    const core = usePaginatedCore<F>(reference, args, options);

    const results = computed<PageItemOf<F>[]>(() => {
        const items: PageItemOf<F>[] = [];

        for (const result of core.pageResults()) {
            if (result) {
                items.push(...result.page);
            }
        }

        return items;
    });

    const isLoading = computed<boolean>(() => {
        const statusValue = core.status();

        return statusValue === "LoadingFirstPage" || statusValue === "LoadingMore";
    });

    return {
        isLoading,
        loadMore: core.loadMore,
        results,
        status: core.status,
    };
};

/**
 * Subscribe to a reactively-paginated query and expose its pages discretely.
 *
 * Shares `paginatedQuery`'s reactive-pagination engine but keeps each page as
 * its own inner array rather than flattening them, and adds the TanStack-Query-
 * style `fetchNextPage` / `hasNextPage` / `isFetchingNextPage` shape.
 *
 * Call from an injection context:
 * ```ts
 * readonly feed = infiniteQuery(api.messages.list, {}, { initialNumItems: 20 });
 * ```
 * @experimental
 */
export const infiniteQuery = <F extends FunctionReference>(
    reference: F,
    args: PaginatedArgs<F> | "skip",
    options: PaginatedQueryOptions,
): InfiniteQueryResult<PageItemOf<F>> => {
    const { initialNumItems } = options;
    const core = usePaginatedCore<F>(reference, args, options);

    const pages = computed<PageItemOf<F>[][]>(() => {
        const resultArrays: PageItemOf<F>[][] = [];

        for (const page of core.pageResults()) {
            if (page) {
                resultArrays.push(page.page);
            }
        }

        return resultArrays;
    });

    const isLoading = computed<boolean>(() => core.status() === "LoadingFirstPage");
    const hasNextPage = computed<boolean>(() => core.status() === "CanLoadMore");
    const isFetchingNextPage = computed<boolean>(() => core.status() === "LoadingMore");

    const fetchNextPage = (numberItems?: number): void => {
        core.loadMore(numberItems ?? initialNumItems);
    };

    return {
        fetchNextPage,
        hasNextPage,
        isFetchingNextPage,
        isLoading,
        pages,
        status: core.status,
    };
};
