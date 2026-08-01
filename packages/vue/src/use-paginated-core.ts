import type { FunctionReference, Unsubscribe } from "@lunora/client";
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
    options: { initialNumItems: number; shardKey?: string },
): PaginatedCoreVueResult<T> => {
    const client = useLunora();
    const { initialNumItems, shardKey } = options;

    const pages = shallowRef<Page[]>(initialPages(initialNumItems));
    const pageResults = shallowRef<(PaginationResult<T> | undefined)[]>([]);

    /**
     * The cursor the most recent `loadMore` applied. `pageResults` is only
     * rebuilt in a pre-flush watcher after `pages` changes, so two synchronous
     * `loadMore` calls (a double-click before the next flush) would both read the
     * same stale tail and re-apply the same `nextCursor` — pinning the just-added
     * open tail into a degenerate empty range and appending a duplicate tail.
     * Track the last-applied cursor and no-op a repeat within the same flush.
     */
    let lastLoadMoreCursor: null | string | undefined;

    /**
     * Each active subscription entry. `currentKey` is mutable so that when
     * `loadMore` re-keys a pinned page, the callback still stores its result
     * under the correct key without needing a closure rebind.
     */
    interface SubEntry {
        currentKey: string;
        unsub: Unsubscribe;
    }

    /** Active subscriptions keyed by their ORIGINAL page key (stable across re-keys). */
    const activeSubs = new Map<string, SubEntry>();

    /** Results keyed by `currentKey`, kept in sync when `loadMore` re-keys pages. */
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

        // Close stale subscriptions (those whose currentKey is no longer wanted).
        for (const [originalKey, entry] of activeSubs) {
            if (!wantedKeys.has(entry.currentKey)) {
                entry.unsub();
                activeSubs.delete(originalKey);
                resultsByKey.delete(entry.currentKey);
                // Drop any pending marker for this key too — a page closed before
                // its first result would otherwise orphan its key in
                // `pendingPageKeys` forever, permanently disabling the
                // `pendingPageKeys.size === 0` split/join rebalance gate below.
                pendingPageKeys.delete(entry.currentKey);
            }
        }

        // Open new subscriptions for pages that have no active sub.
        const coveredKeys = new Set<string>([...activeSubs.values()].map((subEntry) => subEntry.currentKey));

        for (const page of currentPages) {
            const pageArgs = buildPageArgs(page, baseArgs);
            const key = buildPageKey(function_["__lunoraRef"], pageArgs);

            if (coveredKeys.has(key)) {
                continue;
            }

            const entry: SubEntry = {
                currentKey: key,
                unsub: undefined as unknown as Unsubscribe,
            };

            // Mark this page as pending until its first result arrives.
            pendingPageKeys.add(key);

            const unsub = client.subscribe(
                function_,
                pageArgs,
                (value) => {
                    // Write to entry.currentKey — this may have been updated by
                    // `loadMore` re-keying without closing the subscription.
                    resultsByKey.set(entry.currentKey, value as PaginationResult<T>);

                    // This page has resolved; remove from the pending set.
                    pendingPageKeys.delete(entry.currentKey);

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
                { shardKey },
            );

            entry.unsub = unsub;
            activeSubs.set(key, entry);
            coveredKeys.add(key);
        }
    };

    const teardownAll = (): void => {
        for (const entry of activeSubs.values()) {
            entry.unsub();
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
        // pin an empty range and append a duplicate tail (self-heals only via a
        // JOIN pass, which finding-1's leak could otherwise disable forever).
        if (nextCursor === lastLoadMoreCursor) {
            return;
        }

        const next = applyLoadMore(pages.value, nextCursor, numberItems);

        if (!next) {
            return;
        }

        lastLoadMoreCursor = nextCursor;

        // `applyLoadMore` pins the open-ended tail: the last page's args shift
        // from `endCursor: null` to `endCursor: cursor`. Re-key the existing
        // subscription entry (by updating its `currentKey`) and the result map
        // so both survive without closing/reopening the socket subscription.
        const oldTail = pages.value.at(-1);
        const newPinnedPage = next.at(-2); // `applyLoadMore` inserts the new tail last

        if (oldTail && newPinnedPage) {
            const oldKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(oldTail, currentArgs));
            const newKey = buildPageKey(function_["__lunoraRef"], buildPageArgs(newPinnedPage, currentArgs));
            const entry = activeSubs.get(oldKey);

            if (entry && oldKey !== newKey) {
                // Update the entry's key so its callback writes to the right slot.
                entry.currentKey = newKey;
                // Re-register under the new key in activeSubs.
                activeSubs.set(newKey, entry);
                activeSubs.delete(oldKey);
                // Migrate the stored result.
                const carried = resultsByKey.get(oldKey);

                if (carried) {
                    resultsByKey.set(newKey, carried);
                    resultsByKey.delete(oldKey);
                }
            }
        }

        pages.value = next;
    };

    return { loadMore, pageResults, status };
};

export type { PaginatedCoreVueResult };
export { usePaginatedCore };
