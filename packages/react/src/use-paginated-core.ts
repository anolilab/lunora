"use client";

import type { FunctionReference } from "@lunora/client";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getSubscriptionRegistry, lunoraQueryKey, serializeQueryKey } from "./cache";
import { useLunora } from "./lunora-provider";
import type { PaginationResult, PaginationStatus } from "./types";
import useLazyRef from "./use-lazy-ref";

/**
 * Shared mechanics for Lunora's Convex-parity *reactive* pagination, driving
 * both `usePaginatedQuery` (flattened feed) and `useInfiniteQuery` (per-page
 * arrays).
 *
 * Where the legacy model fetched each page as "first `numItems` rows after the
 * previous page's last-row cursor" — independent subscriptions whose start
 * cursors drifted whenever a row landed in the middle of the list, producing
 * duplicated/skipped rows at page boundaries under live edits — this core tracks
 * pages as an ordered list of stable boundary cursors and subscribes each page
 * to a FIXED half-open range `(lower, upper]`:
 *
 * - Page `i`'s `upper` IS page `i+1`'s `lower`. Boundaries are shared stable
 * cursors, so there are no gaps and no duplicates even as rows are inserted or
 * deleted: the page containing an insert simply GROWS, a page losing a row
 * SHRINKS, and neighbours are untouched (their boundaries hold).
 * - The final, still-growing page is open-ended (`upper === null`) and returns
 * up to `numItems` rows plus a fresh `continueCursor` used to open the next page
 * on `loadMore`.
 *
 * Two maintenance passes keep page sizes near their target as edits accumulate
 * (mirroring Convex's split/join), so no single page's live subscription grows
 * unbounded and tiny pages collapse back together:
 *
 * - SPLIT: a bounded page whose live result exceeds `SPLIT_FACTOR`× its target
 * `numItems` is cut at the server-provided `splitCursor` (its midpoint row's
 * cursor) into two adjacent ranges sharing that cursor as a boundary.
 * - JOIN: a bounded page that shrinks below `JOIN_FACTOR`× its target and has a
 * following neighbour is merged with it by dropping the shared boundary.
 *
 * Each page is its own dedup'd live subscription keyed (through the client) by
 * `(fnRef, args, shardKey)` where `args.paginationOpts` carries the page's
 * `(cursor=lower, endCursor=upper, numItems)` — so a delta on one range patches
 * exactly that page.
 */

/** Grow factor: a bounded page is split when it exceeds this multiple of its target size. */
const SPLIT_FACTOR = 2;

/** Shrink factor: a bounded page with a neighbour is joined when it falls below this multiple of its target size. */
const JOIN_FACTOR = 0.5;

/** A loaded page: a fixed `(lower, upper]` range plus the size it targets. */
interface Page {
    // `null | string` mirrors the server's cursor wire shape: a `lower` of
    // `null` is the first-page start; an `upper` of `null` is the open-ended
    // (still-growing) final page.
    lower: null | string;
    numItems: number;
    upper: null | string;
}

interface PaginatedCoreResult<T> {
    /** Request another page off the open-ended tail. A no-op unless `status === "CanLoadMore"`. */
    loadMore: (numberItems: number) => void;
    /** Per-page resolved results in order; entries are `undefined` until a page resolves. */
    pageResults: (PaginationResult<T> | undefined)[];
    status: PaginationStatus;
}

/** First-page seed: a single open-ended range starting at the feed head. */
const initialPages = (numberItems: number): Page[] => [
    // eslint-disable-next-line unicorn/no-null -- `lower: null` is the feed head, `upper: null` the open-ended tail — both are wire-shape cursors.
    { lower: null, numItems: numberItems, upper: null },
];

/**
 * Run the SPLIT/JOIN maintenance pass over the current page list given freshly
 * resolved results. Returns a new page list when a boundary changed, or
 * `undefined` when the layout is already balanced (so the caller can skip a
 * setState).
 *
 * Only ONE structural edit is applied per pass (the first split or join found),
 * letting the subsequent re-render's resolved results drive the next pass — this
 * keeps each transition observable and avoids reasoning about several
 * simultaneous boundary moves.
 */
const rebalance = (pages: Page[], results: (PaginationResult | undefined)[]): Page[] | undefined => {
    for (const [index, page] of pages.entries()) {
        // Only bounded (fully-resolved, fixed-range) pages participate; the
        // open-ended tail grows via `loadMore`, not split/join.
        if (page.upper === null) {
            continue;
        }

        const result = results[index];

        if (!result) {
            continue;
        }

        const size = result.page.length;

        // SPLIT: the range outgrew its target. Cut at the server's midpoint
        // cursor into `(lower, splitCursor]` and `(splitCursor, upper]`.
        if (size > SPLIT_FACTOR * page.numItems && result.splitCursor) {
            const split = result.splitCursor;
            const next = [...pages];

            next.splice(index, 1, { lower: page.lower, numItems: page.numItems, upper: split }, { lower: split, numItems: page.numItems, upper: page.upper });

            return next;
        }

        // JOIN: the range shrank below its target and has a following neighbour;
        // merge by dropping the shared boundary (this page's upper). The merged
        // page keeps this page's lower and the neighbour's upper.
        if (size < JOIN_FACTOR * page.numItems && index + 1 < pages.length) {
            const neighbour = pages[index + 1];

            if (!neighbour) {
                continue;
            }

            const next = [...pages];

            next.splice(index, 2, { lower: page.lower, numItems: page.numItems, upper: neighbour.upper });

            return next;
        }
    }

    return undefined;
};

/**
 * The reactive-pagination engine shared by both public hooks. Owns the page
 * boundary list, the per-page live subscriptions, the split/join maintenance,
 * and `loadMore`; returns the ordered per-page results plus the feed `status`.
 */
const usePaginatedCore = <T>(
    function_: FunctionReference,
    args: "skip" | Record<string, unknown>,
    options: { initialNumItems: number; shardKey?: string },
): PaginatedCoreResult<T> => {
    const client = useLunora();
    const queryClient = useQueryClient();
    const { initialNumItems, shardKey } = options;

    const skipped = args === "skip";
    const baseArgs = skipped ? {} : args;
    const baseArgsKey = JSON.stringify(baseArgs);

    const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
    const [pages, setPages] = useState<Page[]>(() => initialPages(initialNumItems));

    // Reset to the first page whenever the query identity, base args, page size,
    // or shard changes. Set-state-during-render (guarded by a ref) is React's
    // sanctioned way to derive state from changing inputs without an extra commit.
    const resetKey = `${function_.__lunoraRef}::${baseArgsKey}::${String(initialNumItems)}::${shardKey ?? ""}`;
    const resetKeyRef = useRef(resetKey);

    if (resetKeyRef.current !== resetKey) {
        resetKeyRef.current = resetKey;
        setPages(initialPages(initialNumItems));
    }

    // Build the (queryKey, args) pair for each loaded page. `cursor`/`endCursor`
    // carry the page's fixed `(lower, upper]` range so the client opens one
    // dedup'd subscription per range.
    const pageEntries = pages.map((page) => {
        const pageArgs = { ...baseArgs, paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems } };
        const key: QueryKey = lunoraQueryKey(function_, pageArgs, shardKey);

        return { args: pageArgs, key };
    });
    // Stable hash of every loaded page key — the effect dep so we only re-attach
    // when the page set actually changes.
    const pageKeysHash = pageEntries.map(({ key }) => serializeQueryKey(key)).join("|");

    // Read latest desired entries from a ref so the attach effect's dep list can
    // stay keyed on `pageKeysHash` alone — args/fn changes already move the hash.
    const desiredRef = useRef<{ entries: typeof pageEntries; fn: FunctionReference; shardKey: string | undefined }>({ entries: [], fn: function_, shardKey });

    useEffect(() => {
        desiredRef.current = { entries: pageEntries, fn: function_, shardKey };
    });

    // Per-page detach handles so a page falling out of the request set releases
    // its subscription without disturbing the others.
    const detachesRef = useLazyRef((): Map<string, () => void> => new Map());

    // The LunoraClient the current detach handles are bound to. Page-key hashes
    // don't encode client identity, so a client swap (same page keys) would
    // otherwise leave every subscription attached to the old client — detach and
    // rebuild against the new one when this changes.
    const detachClientRef = useRef(client);

    useEffect(() => {
        const detaches = detachesRef.current;

        // Client changed while page keys stayed the same: tear every page's
        // subscription off the old client so the loop below re-attaches them to
        // the new one.
        if (detachClientRef.current !== client) {
            for (const detach of detaches.values()) {
                detach();
            }

            detaches.clear();
            detachClientRef.current = client;
        }

        if (skipped) {
            for (const detach of detaches.values()) {
                detach();
            }

            detaches.clear();

            return;
        }

        const desired = desiredRef.current;
        const registry = getSubscriptionRegistry(client);
        const wanted = new Set(desired.entries.map(({ key }) => serializeQueryKey(key)));

        for (const [hash, detach] of detaches) {
            if (!wanted.has(hash)) {
                detach();
                detaches.delete(hash);
            }
        }

        for (const entry of desired.entries) {
            const hash = serializeQueryKey(entry.key);

            if (detaches.has(hash)) {
                continue;
            }

            // Trigger the initial fetch via TanStack so its dedup applies even
            // when two mounts ask for the same page range. `staleTime: 0` is
            // deliberate here (unlike `useQuery`): split/join recycle page-range
            // queryKeys, so a key can reappear carrying a *prior* boundary
            // configuration's cached rows. Forcing the queryFn to run on every
            // fresh attach guarantees a recycled key never serves that corpse —
            // the live subscription then keeps it current. The attach only fires
            // once per newly-desired page, so this stays a single fetch per page.
            // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from LunoraContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache. Client swaps are handled explicitly via detachClientRef above.
            const initialFetch = queryClient.fetchQuery({
                queryFn: () =>
                    (client.query as (function_: FunctionReference, args: unknown, options: { shardKey?: string }) => Promise<unknown>)(
                        desired.fn,
                        entry.args,
                        {
                            shardKey: desired.shardKey,
                        },
                    ),
                queryKey: entry.key,
                staleTime: 0,
            });

            // Initial fetch failures surface through the live subscription /
            // polling fallback; swallow here so the promise doesn't float.
            initialFetch.catch(() => {});

            detaches.set(hash, registry.attach(queryClient, entry.key, desired.fn, entry.args, desired.shardKey));
        }
    }, [client, queryClient, pageKeysHash, skipped]);

    // Release every page on unmount.
    useEffect(
        () => () => {
            for (const detach of detachesRef.current.values()) {
                detach();
            }

            detachesRef.current.clear();
        },
        [],
    );

    // Subscribe to TanStack cache events so a `setQueryData` from the registry
    // triggers a re-render here.
    useEffect(() => {
        const cache = queryClient.getQueryCache();
        const unsubscribe = cache.subscribe((event) => {
            // The registry pushes page data via `setQueryData`, which emits an
            // `"updated"` event. Every other event type (observer lifecycle,
            // add/remove, etc.) fires on unrelated sibling churn and would only
            // drive a redundant re-render — skip it before any serialization so
            // the per-event JSON.stringify + page scan never runs on them.
            if (event.type !== "updated") {
                return;
            }

            const hash = serializeQueryKey(event.query.queryKey as QueryKey);

            if (pageEntries.some(({ key }) => serializeQueryKey(key) === hash)) {
                forceRender();
            }
        });

        return unsubscribe;
    }, [queryClient, pageKeysHash]);

    const pageResults: (PaginationResult<T> | undefined)[] = skipped ? [] : pageEntries.map(({ key }) => queryClient.getQueryData<PaginationResult<T>>(key));

    // SPLIT/JOIN maintenance: after results resolve, rebalance page boundaries so
    // no page's live range strays far from its target size. Guarded so we only
    // setState when a boundary actually moves. The effect has no dep array, so it
    // closes over this render's `pages` + `pageResults` directly — no render-phase
    // ref snapshot needed. `rebalance` applies one boundary edit per pass; the
    // resulting re-render drives the next until the layout is balanced.
    useEffect(() => {
        if (skipped) {
            return;
        }

        const next = rebalance(pages, pageResults);

        if (next) {
            setPages(next);
        }
    });

    let status: PaginationStatus;
    let nextCursor: null | string | undefined;

    if (skipped || !pageResults[0]) {
        status = "LoadingFirstPage";
    } else {
        const tail = pageResults.at(-1);

        if (!tail) {
            status = "LoadingMore";
        } else if (tail.isDone || tail.continueCursor === null) {
            // The tail is the open-ended page (`upper === null`); a `null`
            // continueCursor / `isDone` means the feed is fully loaded. A bounded
            // tail can't occur — `loadMore` always appends an open-ended page.
            status = "Exhausted";
        } else {
            status = "CanLoadMore";
            nextCursor = tail.continueCursor;
        }
    }

    const nextCursorRef = useRef<null | string | undefined>(undefined);

    // Sync the next-page cursor via an effect rather than a render-phase ref
    // write (which trips React Compiler). It's read only inside the
    // user-triggered `loadMore` below, so the post-commit value is always current
    // by the time it fires — and `loadMore` keeps a stable identity.
    useEffect(() => {
        nextCursorRef.current = status === "CanLoadMore" ? nextCursor : undefined;
    });

    const loadMore = useCallback((numberItems: number) => {
        const cursor = nextCursorRef.current;

        if (cursor === undefined || cursor === null) {
            return;
        }

        // Pin the current open-ended tail at `cursor` (it becomes a fixed
        // `(lower, cursor]` range) and append a fresh open-ended page starting
        // at `cursor`. The shared boundary keeps the feed gap- and dup-free.
        setPages((current) => {
            const next = [...current];
            const tail = next.at(-1);

            if (tail) {
                next[next.length - 1] = { lower: tail.lower, numItems: tail.numItems, upper: cursor };
            }

            // eslint-disable-next-line unicorn/no-null -- a fresh tail is open-ended (`upper: null`); its lower is the just-pinned boundary cursor.
            next.push({ lower: cursor, numItems: numberItems, upper: null });

            return next;
        });
    }, []);

    return { loadMore, pageResults, status };
};

export { JOIN_FACTOR, SPLIT_FACTOR, usePaginatedCore };
export type { Page };
