"use client";

import type { FunctionReference, SubscriptionError, SubscriptionErrorCallback } from "@lunora/client";
import type { Page, PaginatedCoreResult, PaginationResult } from "@lunora/client/pagination";
import { applyLoadMore, derivePaginationStatus, initialPages, rebalance } from "@lunora/client/pagination";
import type { QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { getSubscriptionRegistry, lunoraQueryKey, serializeQueryKey } from "./cache";
import { useLunora } from "./lunora-provider";
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
 *
 * The pure state machine (SPLIT_FACTOR, JOIN_FACTOR, Page type, initialPages,
 * rebalance, derivePaginationStatus, applyLoadMore) lives in
 * `@lunora/client/pagination` so framework-agnostic adapters can reuse it.
 */

/** {@link usePaginatedCore}'s handle: the shared core result plus the error channel. */
interface PaginatedCoreReactResult<T> extends PaginatedCoreResult<T> {
    error: SubscriptionError | undefined;
}

/**
 * The reactive-pagination engine shared by both public hooks. Owns the page
 * boundary list, the per-page live subscriptions, the split/join maintenance,
 * `loadMore`, and the error channel; returns the ordered per-page results plus
 * the feed `status`.
 *
 * A page can fail two ways — its initial fetch rejects, or the server pushes a
 * subscription error — and both land on `error`. A FAILED TAIL that never got a
 * frame is dropped from the page list, so `status` falls back to the previous
 * page's cursor (`"CanLoadMore"`) instead of pinning the feed at
 * `"LoadingMore"` with a permanently no-op `loadMore`. The first page has no
 * previous page to fall back to and stays `"LoadingFirstPage"` with `error` set.
 */
const usePaginatedCore = function <T>(
    function_: FunctionReference,
    args: "skip" | Record<string, unknown>,
    options: { initialNumItems: number; onError?: SubscriptionErrorCallback; shardKey?: string },
): PaginatedCoreReactResult<T> {
    const client = useLunora();
    const queryClient = useQueryClient();
    const { initialNumItems, shardKey } = options;

    const skipped = args === "skip";
    const baseArgs = skipped ? {} : args;

    const [, forceRender] = useReducer((tick: number) => tick + 1, 0);
    const [pages, setPages] = useState<Page[]>(() => initialPages(initialNumItems));
    const [error, setError] = useState<SubscriptionError | undefined>(undefined);

    // The attach effect keys on the page-key hash, so an inline `onError` must
    // not change its identity — register a stable wrapper and read the latest
    // handler through a ref (the same shape `useQuery` uses).
    const onErrorRef = useRef(options.onError);

    useEffect(() => {
        onErrorRef.current = options.onError;
    });

    // Reset to the first page whenever the query identity, base args, page size,
    // or shard changes. Set-state-during-render (guarded by a ref) is React's
    // sanctioned way to derive state from changing inputs without an extra commit.
    //
    // The identity half is built from `serializeQueryKey(lunoraQueryKey(...))`,
    // the same stable encoder every query key/effect dep uses, rather than a raw
    // `JSON.stringify(baseArgs)`: raw stringify is property-order-sensitive (so a
    // conditional-spread arg object of identical content would falsely reset the
    // feed to page one) and would collapse `shardKey: ""` with `shardKey:
    // undefined` — which `lunoraQueryKey` keeps distinct (`""` vs `null`).
    const resetKey = `${serializeQueryKey(lunoraQueryKey(function_, baseArgs, shardKey))}::${String(initialNumItems)}`;
    const resetKeyRef = useRef(resetKey);

    // react-doctor-disable-next-line react-hooks-js/refs -- intentional: React's sanctioned "reset state when an input changes" pattern — compare a render-phase ref to the current reset key and set state during render, guarded so it runs once per change (see comment above).
    if (resetKeyRef.current !== resetKey) {
        // react-doctor-disable-next-line react-hooks-js/refs -- intentional: writing the ref guard here is what makes the render-phase reset fire exactly once per input change (see above).
        resetKeyRef.current = resetKey;
        setPages(initialPages(initialNumItems));
        setError(undefined);
    }

    // Build the (queryKey, args) pair for each loaded page. `cursor`/`endCursor`
    // carry the page's fixed `(lower, upper]` range so the client opens one
    // dedup'd subscription per range.
    // react-doctor-disable-next-line react-doctor/no-event-handler -- false positive: `pageEntries` is derived render state (the per-page (queryKey, args) list), not a faked event handler; the attach effect below reads it via `desiredRef` and keys on `pageKeysHash`. No user event triggers this derivation.
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
    const desiredRef = useRef<{ baseArgs: Record<string, unknown>; entries: typeof pageEntries; fn: FunctionReference; shardKey: string | undefined }>({
        baseArgs,
        entries: [],
        fn: function_,
        shardKey,
    });

    useEffect(() => {
        desiredRef.current = { baseArgs, entries: pageEntries, fn: function_, shardKey };
    });

    /**
     * Record a page failure and, when it is the still-unresolved TAIL of a
     * multi-page feed, drop that page so the feed leaves `"LoadingMore"` and
     * `loadMore` can ask for it again. Reads `desiredRef` so the tail's key is
     * computed from the same fn/args the subscription was opened with.
     */
    const failPage = (hash: string, queryKey: QueryKey, pageError: SubscriptionError): void => {
        setError(pageError);

        setPages((current) => {
            const desired = desiredRef.current;
            const tail = current.at(-1);

            if (current.length <= 1 || !tail || queryClient.getQueryData(queryKey) !== undefined) {
                return current;
            }

            const tailArgs = { ...desired.baseArgs, paginationOpts: { cursor: tail.lower, endCursor: tail.upper, numItems: tail.numItems } };

            return serializeQueryKey(lunoraQueryKey(desired.fn, tailArgs, desired.shardKey)) === hash ? current.slice(0, -1) : current;
        });

        onErrorRef.current?.(pageError);
    };

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
            // eslint-disable-next-line @tanstack/query/exhaustive-deps -- client is provider-stable (it comes from LunoraContext; swapping it remounts the provider subtree) and is intentionally excluded from the cache key: a non-serializable client object would break cache identity and thrash the cache. Client swaps are handled explicitly via detachClientRef above. Unlike the sibling call sites, this one still needs the directive: the callee is wrapped in a type assertion, so the `client.query` MemberExpression's parent is a TSAsExpression rather than the CallExpression, and the rule's `isFunctionCallTarget` check (added in 5.101.4) does not see through it.
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

            // A page whose FIRST fetch rejects has no live subscription frame
            // coming to correct it — route the rejection into the same channel
            // the pushed subscription errors use, or the feed hangs on this page
            // forever.
            initialFetch.catch((error_: unknown) => {
                failPage(
                    hash,
                    entry.key,
                    error_ instanceof Error ? { code: (error_ as { code?: string }).code, message: error_.message } : { message: String(error_) },
                );
            });

            detaches.set(
                hash,
                registry.attach(queryClient, entry.key, desired.fn, entry.args, desired.shardKey, {
                    onError: (pageError) => {
                        failPage(hash, entry.key, pageError);
                    },
                }),
            );
        }
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the attach effect re-runs only when the set of page keys (`pageKeysHash`), the client, or the skip flag changes. `detachesRef`/`desiredRef`/`queryClient` are stable refs read at run time; the latest fn/args/entries come from `desiredRef.current` (updated in a sibling effect). Client swaps are handled explicitly via `detachClientRef`.
    }, [client, queryClient, pageKeysHash, skipped]);

    // Release every page on unmount.
    useEffect(
        () => () => {
            for (const detach of detachesRef.current.values()) {
                detach();
            }

            detachesRef.current.clear();
        },
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: unmount-only cleanup. `detachesRef` is a stable ref, so the empty dep array is correct — the teardown must run once on unmount, not every render.
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
                // A frame for one of our pages landed — the feed is healthy again.
                setError(undefined);
                forceRender();
            }
        });

        return unsubscribe;
        // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: the cache subscription re-attaches only when `pageKeysHash` (or the stable `queryClient`) changes. The inner `pageEntries.some(...)` membership check reads this render's entries by closure, but the subscription itself must not re-attach every render — keying on the hash is the point.
    }, [queryClient, pageKeysHash]);

    const pageResults: (PaginationResult<T> | undefined)[] = skipped ? [] : pageEntries.map(({ key }) => queryClient.getQueryData<PaginationResult<T>>(key));

    // SPLIT/JOIN maintenance: after results resolve, rebalance page boundaries so
    // no page's live range strays far from its target size. Guarded so we only
    // setState when a boundary actually moves. The effect has no dep array, so it
    // closes over this render's `pages` + `pageResults` directly — no render-phase
    // ref snapshot needed. `rebalance` applies one boundary edit per pass; the
    // resulting re-render drives the next until the layout is balanced.
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional: this SPLIT/JOIN maintenance effect deliberately runs every commit (no dep array) so it closes over the freshest `pages`/`pageResults`. `rebalance` applies at most one guarded boundary edit per pass, so the re-render chain converges instead of looping (see the block comment above).
    useEffect(() => {
        if (skipped) {
            return;
        }

        // react-doctor-disable-next-line react-doctor/no-event-handler -- false positive: `rebalance` is a pure derivation over committed `pages`/`pageResults`, run post-commit to converge page sizes — not a side effect that belongs in a user event handler.
        const next = rebalance(pages, pageResults);

        if (next) {
            // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- intentional: the guarded `setPages` applies one boundary edit per pass; the resulting re-render drives the next until the layout balances (see the block comment above). Convergent, not a cascading render.
            setPages(next);
        }
    });

    const { status } = derivePaginationStatus(skipped, pageResults);

    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- load-bearing: the render-phase `resetKeyRef` read above bails React Compiler for this whole hook, so this `useCallback` is the only thing keeping `loadMore`'s identity stable for consumers. Keep it.
    const loadMore = useCallback(
        (numberItems: number) => {
            setError(undefined);
            setPages((current) => {
                // Resolve the next-page cursor from COMMITTED state at call time —
                // the authoritative `current` pages plus the live query cache —
                // rather than a cursor snapshotted into a ref during render. A
                // render-phase ref write can be left holding a value from an
                // interrupted/discarded concurrent render, which `loadMore` (a
                // user-triggered event handler) would then read; deriving here
                // reads only state that actually committed. `fn`/`baseArgs`/
                // `shardKey` come from the effect-updated `desiredRef` so the
                // callback stays identity-stable.
                const desired = desiredRef.current;
                const results = current.map((page) => {
                    const pageArgs = { ...desired.baseArgs, paginationOpts: { cursor: page.lower, endCursor: page.upper, numItems: page.numItems } };

                    return queryClient.getQueryData<PaginationResult<T>>(lunoraQueryKey(desired.fn, pageArgs, desired.shardKey));
                });

                const { nextCursor, status: liveStatus } = derivePaginationStatus(false, results);
                const cursor = liveStatus === "CanLoadMore" ? nextCursor : undefined;

                // applyLoadMore returns undefined when cursor is invalid — no-op.
                return applyLoadMore(current, cursor, numberItems) ?? current;
            });
        },
        [queryClient],
    );

    return { error, loadMore, pageResults, status };
};

export type { PaginatedCoreReactResult };
export default usePaginatedCore;
