import type { FunctionReference, SubscriptionError, SubscriptionErrorCallback, Unsubscribe } from "@lunora/client";
import type { Page, PaginationResult, PaginationStatus } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import type { MaybeRefOrGetter, ShallowRef } from "vue";
import { onScopeDispose, shallowRef, toValue, watch } from "vue";

import { isBrowser } from "../../../shared/is-browser";
import { stableWireKey } from "../../../shared/wire-key";
import { useLunora } from "./lunora-provider";

const buildPageKey = (functionPath: string, pageArgs: Record<string, unknown>): string => `${functionPath}::${stableWireKey(pageArgs)}`;

const buildPageArgs = (page: Page, baseArgs: Record<string, unknown>): Record<string, unknown> => {
    return {
        ...baseArgs,
        paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems },
    };
};

interface PaginatedCoreVueResult<T> {
    /** The last page subscription error; cleared by the next successful frame, `loadMore`, or an args change. */
    error: ShallowRef<SubscriptionError | undefined>;
    /** Request another page off the open-ended tail. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Per-page resolved results in order; entries are `undefined` until a page resolves. */
    pageResults: ShallowRef<(PaginationResult<T> | undefined)[]>;
    status: ShallowRef<PaginationStatus>;
}

/**
 * Vue-native pagination engine shared by `usePaginatedQuery` and
 * `useInfiniteQuery`. Owns the page boundary list, per-page `client.subscribe()`
 * calls, split/join maintenance, and `loadMore`.
 *
 * Unlike the React counterpart this does NOT depend on TanStack Query — state is
 * held in Vue refs and live subscriptions are wired directly to
 * `client.subscribe()`. Cursor logic lives entirely in `@lunora/client/pagination`;
 * this file only adds the reactive Vue glue.
 */
const usePaginatedCore = <T>(
    function_: FunctionReference,
    args: MaybeRefOrGetter<"skip" | Record<string, unknown>>,
    options: { initialNumItems: number; onError?: SubscriptionErrorCallback; shardKey?: string },
): PaginatedCoreVueResult<T> => {
    const client = useLunora();
    const { initialNumItems, onError, shardKey } = options;

    const pages = shallowRef<Page[]>(initialPages(initialNumItems));
    const pageResults = shallowRef<(PaginationResult<T> | undefined)[]>([]);
    const error = shallowRef<SubscriptionError | undefined>(undefined);

    /**
     * The cursor the most recent `loadMore` applied. `pageResults` is only
     * rebuilt in a pre-flush watcher after `pages` changes, so two synchronous
     * `loadMore` calls (a double-click before the next flush) would both read the
     * same stale tail and re-apply the same `nextCursor` — pinning the just-added
     * open tail into a degenerate empty range and appending a duplicate tail.
     * Track the last-applied cursor and no-op a repeat within the same flush; the
     * `pages` watcher clears it once that flush has run.
     */
    let lastLoadMoreCursor: null | string | undefined;

    /** Active subscriptions keyed by page key; `loadMore` closes and reopens a re-keyed page. */
    const activeSubs = new Map<string, Unsubscribe>();

    /** Results keyed by page key. */
    const resultsByKey = new Map<string, PaginationResult<T>>();

    /**
     * After `loadMore` adds a new page, this set tracks the keys of pages that
     * are still awaiting their first result. Rebalance is suppressed while any
     * key is in this set — joining freshly-loaded pages immediately would
     * discard visible content before the new page has even resolved.
     */
    const pendingPageKeys = new Set<string>();

    const rebuildPageResults = (currentPages: Page[], baseArgs: Record<string, unknown>): void => {
        pageResults.value = currentPages.map((page) => {
            const key = buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs));

            return resultsByKey.get(key);
        });
    };

    /**
     * When rebalance splits or joins pages, the result keys change. Carry existing
     * results to the new keys so visible data is preserved while the server
     * acknowledges the new boundary. A joined page seeds its result from the first
     * (lower) of the merged pages; a split page seeds both halves from the parent.
     *
     * This is a best-effort migration — the server will send a fresh result on
     * the new subscription once attached.
     */
    const migrateResultsForRebalance = (oldPages: Page[], newPages: Page[], baseArgs: Record<string, unknown>): void => {
        const keyOf = (page: Page): string => buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs));

        // For each new page, find the best old-result donor.
        for (const newPage of newPages) {
            const newKey = keyOf(newPage);

            if (resultsByKey.has(newKey)) {
                continue; // already have a fresh result
            }

            // Find an old page whose lower bound matches the new page's lower
            // bound — that's the page whose result covers the start of this range.
            const donor = oldPages.find((op) => op.lower === newPage.lower);

            if (donor) {
                const carried = resultsByKey.get(keyOf(donor));

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }
            }
        }
    };

    const syncSubscriptions = (currentPages: Page[], baseArgs: Record<string, unknown>): void => {
        const wantedKeys = new Set<string>();

        for (const page of currentPages) {
            wantedKeys.add(buildPageKey(function_["__lunoraRef"], buildPageArgs(page, baseArgs)));
        }

        // Close stale subscriptions (those whose key is no longer wanted).
        for (const [key, unsub] of activeSubs) {
            if (!wantedKeys.has(key)) {
                unsub();
                activeSubs.delete(key);
                resultsByKey.delete(key);
                // Drop any pending marker for this key too — a page closed before
                // its first result would otherwise orphan its key in
                // `pendingPageKeys` forever, permanently disabling the
                // `pendingPageKeys.size === 0` split/join rebalance gate below.
                pendingPageKeys.delete(key);
            }
        }

        // Open new subscriptions for pages that have no active sub.
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
                    error.value = undefined;

                    // Rebuild the indexed array from the key map.
                    const currentBaseArgs = toValue(args) as Record<string, unknown>;

                    rebuildPageResults(pages.value, currentBaseArgs);

                    // SPLIT/JOIN: only rebalance when no pages are still in their
                    // initial-load phase. A newly appended page (from `loadMore`)
                    // stays in `pendingPageKeys` until its first result arrives;
                    // joining before that would discard visible content.
                    if (pendingPageKeys.size === 0) {
                        const latestPages = pages.value;
                        const next = rebalance(latestPages, pageResults.value);

                        if (next) {
                            migrateResultsForRebalance(latestPages, next, currentBaseArgs);
                            pages.value = next;
                        }
                    }
                },
                {
                    onError: (subscriptionError) => {
                        pendingPageKeys.delete(key);
                        error.value = subscriptionError;

                        // A tail that fails before its first frame is dropped so
                        // the feed leaves `LoadingMore` (status falls back to the
                        // previous page's cursor) and `loadMore` can retry it. The
                        // first page has nothing to fall back to and stays.
                        const current = pages.value;
                        const tail = current.at(-1);

                        if (
                            current.length > 1 &&
                            tail &&
                            !resultsByKey.has(key) &&
                            buildPageKey(function_["__lunoraRef"], buildPageArgs(tail, baseArgs)) === key
                        ) {
                            pages.value = current.slice(0, -1);
                        }

                        onError?.(subscriptionError);
                    },
                    shardKey,
                },
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
        // Clear pending markers so a fresh args cycle isn't wedged by keys left
        // behind from subscriptions torn down before their first result.
        pendingPageKeys.clear();
    };

    // Re-subscribe whenever the base args (or skip) change. Key the watch on a
    // stable string (not object identity) so an equal-but-new args object — e.g.
    // a `computed(() => ({ ids: [...store.selected] }))` recomputed with equal
    // content — never tears down and collapses a multi-page loaded feed back to
    // page one. The live args are re-read inside the callback (matching use-flag).
    watch(
        () => stableWireKey(toValue(args)),
        () => {
            // Client-only: an `immediate: true` watcher fires once during
            // `renderToString` with no unmount to run `onScopeDispose(teardownAll)`
            // (see `use-presence.ts`'s guard rationale) — skip opening page
            // subscriptions server-side and leave `pages`/`pageResults` at their
            // inert initial values.
            if (!isBrowser()) {
                return;
            }

            const current = toValue(args);

            teardownAll();
            pages.value = initialPages(initialNumItems);
            pageResults.value = [];
            error.value = undefined;
            lastLoadMoreCursor = undefined;

            if (current !== "skip") {
                syncSubscriptions(pages.value, current);
                rebuildPageResults(pages.value, current);
            }
        },
        { immediate: true },
    );

    // Re-sync subscriptions whenever `pages` change (e.g., loadMore or rebalance).
    watch(
        () => pages.value,
        (currentPages) => {
            const current = toValue(args);

            // The flush `lastLoadMoreCursor` guards against has run: `pageResults`
            // is rebuilt below, so the next `loadMore` reads a fresh tail.
            lastLoadMoreCursor = undefined;

            if (current !== "skip") {
                syncSubscriptions(currentPages, current);
                rebuildPageResults(currentPages, current);
            }
        },
    );

    onScopeDispose(teardownAll);

    const status = shallowRef<PaginationStatus>("LoadingFirstPage");

    watch(
        [() => toValue(args), pageResults],
        ([currentArgs, currentResults]) => {
            status.value = derivePaginationStatus(currentArgs === "skip", currentResults).status;
        },
        { immediate: true },
    );

    const loadMore = (numberItems: number): void => {
        const currentArgs = toValue(args);

        if (currentArgs === "skip") {
            return;
        }

        const { nextCursor, status: currentStatus } = derivePaginationStatus(false, pageResults.value);

        if (currentStatus !== "CanLoadMore") {
            return;
        }

        // Re-entrancy guard: a second synchronous call sees the same not-yet-
        // rebuilt tail result and the same `nextCursor` — skip it so we don't
        // pin an empty range and append a duplicate tail.
        if (nextCursor === lastLoadMoreCursor) {
            return;
        }

        const next = applyLoadMore(pages.value, nextCursor, numberItems);

        if (!next) {
            return;
        }

        lastLoadMoreCursor = nextCursor;
        error.value = undefined;

        // `applyLoadMore` pins the open-ended tail: the last page's args shift
        // from `endCursor: null` to `endCursor: cursor`. Close the old open-ended
        // subscription, carry its result to the pinned key, and let the `pages`
        // watcher's `syncSubscriptions` open a fresh bounded subscription for the
        // pinned page — an open-ended subscription keeps serving `LIMIT n` rows
        // and no `splitCursor`, so keeping it alive under the pinned key would
        // duplicate/drop rows at the page boundary and never SPLIT.
        const oldTail = pages.value.at(-1);
        const newPinnedPage = next.at(-2); // `applyLoadMore` inserts the new tail last

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(oldTail, currentArgs));
            const newKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(newPinnedPage, currentArgs));
            const unsub = activeSubs.get(oldKey);

            if (unsub && oldKey !== newKey) {
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                }

                unsub();
                activeSubs.delete(oldKey);
                resultsByKey.delete(oldKey);
                pendingPageKeys.delete(oldKey);
            }
        }

        pages.value = next;
    };

    return { error, loadMore, pageResults, status };
};

export type { PaginatedCoreVueResult };
export { usePaginatedCore };
