import type { FunctionReference, LunoraClient, SubscriptionError, Unsubscribe } from "@lunora/client";
import type { PaginationResult } from "@lunora/client/pagination";
import { get, writable } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { infiniteQuery, paginatedQuery } from "../src/paginated-query";

interface SubscribeCall {
    args: Record<string, unknown>;
    callback: (data: unknown) => void;
    functionPath: string;
}

const createFakePaginatedClient = () => {
    const subscribeCalls: SubscribeCall[] = [];

    const subscribe = (function_: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void): Unsubscribe => {
        subscribeCalls.push({
            args,
            callback,
            functionPath: function_["__lunoraRef"],
        });

        return () => undefined;
    };

    const client = { subscribe } as unknown as LunoraClient;

    const push = (args: Record<string, unknown>, value: unknown): void => {
        const argsKey = JSON.stringify(args);

        for (const call of subscribeCalls) {
            if (JSON.stringify(call.args) === argsKey) {
                call.callback(value);
            }
        }
    };

    return { client, push, subscribeCalls };
};

const flushAsync = async (): Promise<void> => {
    await vi.waitFor(() => undefined);
};

const fn = { __lunoraRef: "messages:list" } as FunctionReference;

/**
 * Tests use `initialNumItems: 5` and push exactly 5 items per page so that
 * the rebalance thresholds (JOIN at < 0.5×5 = 2.5, SPLIT at > 2×5 = 10) are
 * never crossed. This lets the tests verify the pagination lifecycle without
 * triggering split/join maintenance passes.
 */
const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

// Every subscribing primitive in this package gates on a browser `window` (the
// SSR guard — svelte's server runtime subscribes to `{$store}` during
// `render()`, so a `readable`'s start callback runs on the server too). The
// vitest env is `node`, so define one for the client-path tests. Mirrors the
// same stub in `flag.test.ts` / `presence.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe("paginatedQuery (Svelte)", () => {
    it("first page loads and results flatten", async () => {
        const fake = createFakePaginatedClient();

        const { results, status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        expect(get(status)).toBe("LoadingFirstPage");
        expect(get(results)).toStrictEqual([]);

        const firstPage: PaginationResult<{ id: string }> = {
            continueCursor: "cur-1",
            isDone: false,
            page: firstPageItems,
        };

        fake.push({ paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } }, firstPage);
        await flushAsync();

        expect(get(status)).toBe("CanLoadMore");
        expect(get(results)).toStrictEqual(firstPageItems);

        stopStatus();
        stopResults();
    });

    it("loadMore appends a second page", async () => {
        const fake = createFakePaginatedClient();

        const { loadMore, results, status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        // Deliver first page.
        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(status)).toBe("CanLoadMore");

        // Call loadMore.
        loadMore(NUM_ITEMS);
        await flushAsync();

        // Second page subscription.
        fake.push(
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );
        await flushAsync();

        expect(get(results)).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(get(status)).toBe("Exhausted");

        stopStatus();
        stopResults();
    });

    it("skip short-circuits to LoadingFirstPage", async () => {
        const fake = createFakePaginatedClient();

        const { isLoading, status } = paginatedQuery(fake.client, fn, "skip", { initialNumItems: NUM_ITEMS });
        const stopStatus = status.subscribe(() => {});

        await flushAsync();

        expect(get(status)).toBe("LoadingFirstPage");
        expect(fake.subscribeCalls).toHaveLength(0);
        // `status` alone is "LoadingFirstPage" for a skipped feed, so a spinner
        // bound to `isLoading` would never stop — React's `!skipped` contract.
        expect(get(isLoading)).toBe(false);

        stopStatus();
    });

    it("last page reports Exhausted", async () => {
        const fake = createFakePaginatedClient();

        const { status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });
        const stopStatus = status.subscribe(() => {});

        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(status)).toBe("Exhausted");

        stopStatus();
    });
});

describe("paginatedQuery page errors", () => {
    it("a page error surfaces on `error`, returns status to CanLoadMore, and lets loadMore retry", async () => {
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void; onError?: (error: SubscriptionError) => void }[] = [];

        const client = {
            subscribe: (
                _fn: FunctionReference,
                args: Record<string, unknown>,
                callback: (data: unknown) => void,
                options?: { onError?: (error: SubscriptionError) => void },
            ) => {
                subscribeCalls.push({ args, callback, onError: options?.onError });

                return () => undefined;
            },
        } as unknown as LunoraClient;

        const errors: SubscriptionError[] = [];
        const { error, isLoading, loadMore, results, status } = paginatedQuery(client, fn, {}, { initialNumItems: NUM_ITEMS, onError: (e) => errors.push(e) });

        const stops = [results.subscribe(() => {}), status.subscribe(() => {}), error.subscribe(() => {}), isLoading.subscribe(() => {})];
        const find = (opts: Record<string, unknown>) => subscribeCalls.find((c) => JSON.stringify(c.args) === JSON.stringify({ paginationOpts: opts }));

        find({ cursor: null, endCursor: null, numItems: NUM_ITEMS })?.callback({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        loadMore(NUM_ITEMS);
        await flushAsync();

        expect(get(status)).toBe("LoadingMore");

        // An RLS denial on the new page: without an error channel the feed sat
        // in `LoadingMore` forever with `isLoading` true and nothing surfaced.
        const tailArgs = { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS };

        find(tailArgs)?.onError?.({ code: "FORBIDDEN", message: "denied" });
        await flushAsync();

        expect(errors).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
        expect(get(error)).toStrictEqual({ code: "FORBIDDEN", message: "denied" });
        expect(get(status)).toBe("CanLoadMore");
        expect(get(isLoading)).toBe(false);
        expect(get(results)).toStrictEqual(firstPageItems);

        // The failed tail was dropped, so `loadMore` re-opens exactly that range.
        const before = subscribeCalls.length;

        loadMore(NUM_ITEMS);
        await flushAsync();

        expect(get(error)).toBeUndefined();
        expect(get(status)).toBe("LoadingMore");
        expect(subscribeCalls.slice(before).map((c) => c.args["paginationOpts"])).toStrictEqual([tailArgs]);

        for (const stop of stops) {
            stop();
        }
    });
});

describe("paginatedQuery teardown (BUG 1 regression)", () => {
    it("unsubscribing the last subscriber closes all page subscriptions", async () => {
        const unsubCallCount = { value: 0 };
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void }[] = [];

        const client = {
            subscribe: (_fn: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void) => {
                subscribeCalls.push({ args, callback });

                return () => {
                    unsubCallCount.value += 1;
                };
            },
        } as unknown as import("@lunora/client").LunoraClient;

        const { results, status } = paginatedQuery(client, fn, {}, { initialNumItems: NUM_ITEMS });

        // Subscribe to two derived stores — this opens the lazy readable.
        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        // Deliver first page to confirm the subscription is live.
        const firstPage: import("@lunora/client/pagination").PaginationResult<{ id: string }> = {
            continueCursor: "cur-1",
            isDone: false,
            page: firstPageItems,
        };

        subscribeCalls[0]?.callback(firstPage);
        await flushAsync();

        expect(subscribeCalls).toHaveLength(1);
        expect(unsubCallCount.value).toBe(0);

        // Unsubscribe — the lazy readable's stop callback must run.
        stopStatus();
        stopResults();
        await flushAsync();

        // The single page subscription must have been closed.
        expect(unsubCallCount.value).toBe(1);
    });

    it("loadMore subscriptions are also torn down on unsubscribe", async () => {
        const unsubCallCount = { value: 0 };
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void }[] = [];

        const client = {
            subscribe: (_fn: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void) => {
                subscribeCalls.push({ args, callback });

                return () => {
                    unsubCallCount.value += 1;
                };
            },
        } as unknown as import("@lunora/client").LunoraClient;

        const { loadMore, results, status } = paginatedQuery(client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        // Deliver page 1.
        subscribeCalls[0]?.callback({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        loadMore(NUM_ITEMS);
        await flushAsync();

        // Deliver page 2.
        const secondSub = subscribeCalls.find(
            (c) => JSON.stringify(c.args) === JSON.stringify({ paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } }),
        );
        secondSub?.callback({ continueCursor: null, isDone: true, page: secondPageItems });
        await flushAsync();

        // Before unsubscribe: `loadMore` may have closed the old open-tail sub
        // (when it was re-keyed to the pinned sub) — that's a legitimate internal
        // close, not a leak. Record the count now so we can assert the delta.
        const unsubBeforeStop = unsubCallCount.value;

        // Unsubscribe the last Svelte subscriber — the lazy readable must teardown.
        stopStatus();
        stopResults();
        await flushAsync();

        // After the last subscriber leaves, teardownAll must have closed every
        // remaining active page subscription (pinned page-1 + page-2 = 2).
        // unsubBeforeStop accounts for any subs already closed by loadMore re-keying.
        expect(unsubCallCount.value - unsubBeforeStop).toBeGreaterThanOrEqual(2);
    });
});

describe("paginatedQuery pending-page rebalance guard (BUG 2 regression)", () => {
    it("shrinking edit on old tail before new page resolves does not undo loadMore", async () => {
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void }[] = [];

        const client = {
            subscribe: (_fn: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void) => {
                subscribeCalls.push({ args, callback });

                return () => undefined;
            },
        } as unknown as import("@lunora/client").LunoraClient;

        const { loadMore, results, status } = paginatedQuery(client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        // Deliver a full first page (5 items, isDone: false → CanLoadMore).
        subscribeCalls[0]?.callback({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(get(status)).toBe("CanLoadMore");

        // Call loadMore — this pins the first page and opens a subscription for page 2.
        loadMore(NUM_ITEMS);
        await flushAsync();

        // Page 2 subscription is now open but has NOT resolved yet.
        // Now push a shrinking update on the PINNED page-1 before page-2 resolves.
        // With the original bug, this triggered JOIN (1 item < 0.5 × 5 = 2.5) which
        // would merge the not-yet-resolved page-2 away — silently undoing loadMore.
        const pinnedFirstPageSub = subscribeCalls.find(
            (c) => JSON.stringify(c.args) === JSON.stringify({ paginationOpts: { cursor: null, endCursor: "cur-1", numItems: NUM_ITEMS } }),
        );

        // Push only 1 item — well below JOIN_FACTOR × NUM_ITEMS (= 2.5).
        pinnedFirstPageSub?.callback({ continueCursor: "cur-1", isDone: false, page: [{ id: "a" }] });
        await flushAsync();

        // Because page-2 is still pending, rebalance must be suppressed.
        // The status must still be "LoadingMore" (page-2 awaiting), NOT "Exhausted".
        // If the bug were present, the JOIN would have dropped page-2 and status
        // would flip to "Exhausted" or "CanLoadMore" before page-2 ever resolved.
        expect(get(status)).toBe("LoadingMore");

        // The results at this point should contain only the 1 shrunken item from
        // page-1 — page-2 hasn't resolved, and the guard prevented the JOIN.
        expect(get(results)).toHaveLength(1);

        stopStatus();
        stopResults();
    });
});

describe("paginatedQuery rebalance result migration (FINDING 1 & 2 regression)", () => {
    it("a JOIN carries the surviving result to the merged page instead of dropping it or resurrecting stale data", async () => {
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void }[] = [];

        const client = {
            subscribe: (_fn: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void) => {
                subscribeCalls.push({ args, callback });

                return () => undefined;
            },
        } as unknown as import("@lunora/client").LunoraClient;

        // JOIN fires below 0.5 × numItems; SPLIT above 2 × numItems. With
        // initialNumItems 4, JOIN triggers when a bounded page drops below 2.
        const NUM = 4;
        const pushTo = (args: Record<string, unknown>, value: unknown): void => {
            const key = JSON.stringify(args);
            const call = subscribeCalls.find((c) => JSON.stringify(c.args) === key);

            call?.callback(value);
        };

        const { loadMore, results } = paginatedQuery(client, fn, {}, { initialNumItems: NUM });

        const stopResults = results.subscribe(() => {});

        // First (open-tail) page delivers a full 4-item page → CanLoadMore.
        pushTo(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM } },
            { continueCursor: "c1", isDone: false, page: [{ id: "1" }, { id: "2" }, { id: "3" }, { id: "4" }] },
        );
        await flushAsync();

        // loadMore pins page-1 as `{null → c1}` and opens an open tail `{c1 → null}`.
        loadMore(NUM);
        await flushAsync();

        // Page-2 resolves and is exhausted.
        pushTo({ paginationOpts: { cursor: "c1", endCursor: null, numItems: NUM } }, { continueCursor: null, isDone: true, page: [{ id: "5" }, { id: "6" }] });
        await flushAsync();

        // Now the pinned page-1 shrinks to a single item (< JOIN threshold of 2).
        // rebalance JOINs page-1 with the tail → the merged page's key is exactly
        // the ORIGINAL open-tail key `{null → null}`.
        pushTo({ paginationOpts: { cursor: null, endCursor: "c1", numItems: NUM } }, { continueCursor: "c1", isDone: false, page: [{ id: "x" }] });
        await flushAsync();

        // FINDING 1: the merged page must carry the surviving page-1 result — not
        // emit `undefined` and blank the feed (`length` would be 0).
        // FINDING 2: the merged key must NOT serve the stale pre-loadMore 4-item
        // result (`length` would be 4) — the loadMore re-key pruned that entry.
        expect(get(results)).toStrictEqual([{ id: "x" }]);

        stopResults();
    });
});

/**
 * A `LunoraClient` stand-in whose `subscribe` replays a preseeded cached value
 * to the new subscriber SYNCHRONOUSLY — the callback fires before `subscribe`
 * returns, exactly like the real client (`lunora-client.ts` replays `lastValue`
 * before handing back the unsubscribe handle). This is the trigger for the
 * reentrant-`syncSubscriptions` bug the guard fixes.
 */
interface ReplaySub {
    args: Record<string, unknown>;
    key: string;
    push: (value: unknown) => void;
    unsubscribed: boolean;
}

const createReplayFake = (): { cache: Map<string, unknown>; client: LunoraClient; subs: ReplaySub[] } => {
    const subs: ReplaySub[] = [];
    const cache = new Map<string, unknown>();

    const client = {
        subscribe: (_function: FunctionReference, args: Record<string, unknown>, callback: (value: unknown) => void): Unsubscribe => {
            const key = JSON.stringify(args);
            const sub: ReplaySub = { args, key, push: callback, unsubscribed: false };

            subs.push(sub);

            if (cache.has(key)) {
                // Synchronous replay — fires before this `subscribe` call returns.
                callback(cache.get(key));
            }

            return () => {
                sub.unsubscribed = true;
            };
        },
    };

    return { cache, client: client as unknown as LunoraClient, subs };
};

describe("paginatedQuery reentrancy (BUG: leaked WS subscription regression)", () => {
    it("reentrant rebalance during a synchronous cached replay does not orphan or duplicate page subscriptions", () => {
        const fake = createReplayFake();

        const numItems = 2; // SPLIT_FACTOR (2) × numItems = 4 → a 5-item page splits.
        const { loadMore, results } = paginatedQuery(fake.client, fn, {}, { initialNumItems: numItems });

        // Open the lazy readable so the first page subscribes.
        const stopResults = results.subscribe(() => {});

        // Resolve the first (open-ended) page so the feed can `loadMore`.
        const firstKey = JSON.stringify({ paginationOpts: { cursor: null, endCursor: null, numItems } });

        for (const sub of fake.subs) {
            if (sub.key === firstKey && !sub.unsubscribed) {
                sub.push({ continueCursor: "c1", isDone: false, page: [{ id: "a" }, { id: "b" }] });
            }
        }

        // Preseed an OVERSIZED cached result for the page `loadMore` pins, so its
        // fresh subscription replays synchronously and triggers a split mid-sync.
        const pinnedKey = JSON.stringify({ paginationOpts: { cursor: null, endCursor: "c1", numItems } });

        fake.cache.set(pinnedKey, {
            continueCursor: "c1",
            isDone: false,
            page: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
            splitCursor: "mid",
        });

        loadMore(numItems);

        // The pinned page split into (null,"mid"] + ("mid","c1"], leaving three live
        // pages: the two split halves and the open-ended tail.
        const open = fake.subs.filter((sub) => !sub.unsubscribed);

        expect(open).toHaveLength(3);

        // No subscription survives for the now-dead pre-split pinned key…
        expect(open.some((sub) => sub.key === pinnedKey)).toBe(false);

        // …and the open-ended tail is covered exactly once (no reentrant duplicate).
        const tailKey = JSON.stringify({ paginationOpts: { cursor: "c1", endCursor: null, numItems } });

        expect(open.filter((sub) => sub.key === tailKey)).toHaveLength(1);

        // Every handle is tracked: unsubscribing the last store subscriber tears
        // every one of them down — none orphaned.
        stopResults();

        expect(fake.subs.every((sub) => sub.unsubscribed)).toBe(true);
    });
});

describe("infiniteQuery (Svelte)", () => {
    it("first page loads as first page array", async () => {
        const fake = createFakePaginatedClient();

        const { isLoading, pages } = infiniteQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

        const stopLoading = isLoading.subscribe(() => {});
        const stopPages = pages.subscribe(() => {});

        expect(get(isLoading)).toBe(true);
        expect(get(pages)).toStrictEqual([]);

        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        expect(get(isLoading)).toBe(false);
        expect(get(pages)).toStrictEqual([firstPageItems]);

        stopLoading();
        stopPages();
    });

    it("fetchNextPage appends second page array", async () => {
        const fake = createFakePaginatedClient();

        const { fetchNextPage, pages } = infiniteQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });
        const stopPages = pages.subscribe(() => {});

        // First page.
        fake.push(
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );
        await flushAsync();

        fetchNextPage();
        await flushAsync();

        // Second page.
        fake.push(
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );
        await flushAsync();

        expect(get(pages)).toStrictEqual([firstPageItems, secondPageItems]);

        stopPages();
    });
});

// Plan 285 — converge on `stableWireKey` for page keys instead of raw
// `JSON.stringify`.
//
// Open Question 1 (answered by reading `createPaginatedEngine`):
// `currentBaseArgs` is a `const` captured once per engine and never rebuilt —
// so within a SINGLE engine instance, `buildPageKey`'s output is deterministic
// and property order never drifts across the calls this file makes. The
// plan's headline "duplicate subscriptions" / "result-carry miss"
// consequences are about TWO SEPARATE component instances whose args are
// structurally equal but built with different property order — that
// collapses (or doesn't) at the underlying `client.subscribe` /
// `SubscriptionRegistry` dedup layer, which already uses `stableWireKey` (per
// plan 285 §1) and is external to this adapter's own bookkeeping; this file's
// hand-rolled fake `subscribe` doesn't model that dedup, so there is no
// reachable pre/post-fix difference to assert for the permutation/
// result-carry scenarios via this file's harness (Test plan items 1–2's own
// downgrade allowance). The wire-typed-arg test below is the reachable,
// demonstrably pre/post-fix-differentiating case.
describe("paginatedQuery — stableWireKey page keys (plan 285)", () => {
    it("accepts a bigint in the query args without throwing (wire-typed arg)", () => {
        const fake = createFakePaginatedClient();

        // Pre-fix, `buildPageKey` used raw `JSON.stringify`, which throws
        // `TypeError: Do not know how to serialize a BigInt` the instant the
        // lazy readable's first subscriber opens the page subscription and
        // computes the key. Post-fix, `stableWireKey` tokenizes it
        // deterministically instead.
        const { results } = paginatedQuery(fake.client, fn, { since: 10n }, { initialNumItems: NUM_ITEMS });

        expect(() => {
            const stop = results.subscribe(() => {});

            stop();
        }).not.toThrow();

        expect(fake.subscribeCalls).toHaveLength(1);
    });

    it("subscribes normally when caller args are not in canonical key order", () => {
        const fake = createFakePaginatedClient();

        const { results, status } = paginatedQuery(fake.client, fn, { b: 1, a: 2 }, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        expect(fake.subscribeCalls).toHaveLength(1);
        expect(get(status)).toBe("LoadingFirstPage");

        stopStatus();
        stopResults();
    });
});

describe("paginatedQuery with reactive args", () => {
    const createTrackingClient = () => {
        const unsubCallCount = { value: 0 };
        const subscribeCalls: { args: Record<string, unknown>; callback: (data: unknown) => void }[] = [];

        const client = {
            subscribe: (_fn: FunctionReference, args: Record<string, unknown>, callback: (data: unknown) => void) => {
                subscribeCalls.push({ args, callback });

                return () => {
                    unsubCallCount.value += 1;
                };
            },
        } as unknown as LunoraClient;

        return { client, subscribeCalls, unsubCallCount };
    };

    it("an args emission tears down the old pages and rebuilds against the new args", async () => {
        const { client, subscribeCalls, unsubCallCount } = createTrackingClient();
        const argsStore = writable<Record<string, unknown> | "skip">({ room: "a" });

        const { results, status } = paginatedQuery(client, fn, argsStore, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        expect(subscribeCalls).toHaveLength(1);
        expect(subscribeCalls[0]?.args).toMatchObject({ room: "a" });

        subscribeCalls[0]?.callback({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(get(results)).toStrictEqual(firstPageItems);

        argsStore.set({ room: "b" });
        await flushAsync();

        // The old page subscription closed; a fresh first-page subscription
        // opened against the new args with pagination reset to page one.
        expect(unsubCallCount.value).toBe(1);
        expect(subscribeCalls).toHaveLength(2);
        expect(subscribeCalls[1]?.args).toMatchObject({
            paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS },
            room: "b",
        });
        expect(get(status)).toBe("LoadingFirstPage");
        expect(get(results)).toStrictEqual([]);

        stopStatus();
        stopResults();
    });

    it("a 'skip' emission tears down without re-opening", async () => {
        const { client, subscribeCalls, unsubCallCount } = createTrackingClient();
        const argsStore = writable<Record<string, unknown> | "skip">({ room: "a" });

        const { results, status } = paginatedQuery(client, fn, argsStore, { initialNumItems: NUM_ITEMS });

        const stopStatus = status.subscribe(() => {});
        const stopResults = results.subscribe(() => {});

        subscribeCalls[0]?.callback({ continueCursor: "cur-1", isDone: false, page: firstPageItems });
        await flushAsync();

        expect(get(results)).toStrictEqual(firstPageItems);

        argsStore.set("skip");
        await flushAsync();

        expect(unsubCallCount.value).toBe(1);
        expect(subscribeCalls).toHaveLength(1);
        expect(get(status)).toBe("LoadingFirstPage");
        expect(get(results)).toStrictEqual([]);

        stopStatus();
        stopResults();
    });
});

// Regression: `readable`'s start callback is NOT browser-only. Svelte's server
// runtime resolves `{$store}` by calling `subscribe_to_store`, so every store
// read in a server-rendered template runs its start callback — opening a live
// socket per rendered request against a client whose URL does not resolve
// server-side, and throwing straight out of the render when that URL is the
// relative/empty one the SvelteKit template builds.
describe("paginatedQuery during SSR", () => {
    it("opens no page subscriptions without a browser window", () => {
        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = createFakePaginatedClient();
            const { results, status } = paginatedQuery(fake.client, fn, {}, { initialNumItems: NUM_ITEMS });

            const stop = results.subscribe(() => {});

            expect(fake.subscribeCalls).toHaveLength(0);
            expect(get(results)).toStrictEqual([]);
            expect(get(status)).toBe("LoadingFirstPage");

            stop();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});
