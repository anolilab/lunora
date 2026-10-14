import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
import type { PaginationResult } from "@lunora/client/pagination";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { infiniteQuery, paginatedQuery } from "../src/paginated-query";
import type { FakeClient } from "./fake-client";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const fn = { __lunoraRef: "messages:list" } as FunctionReference;

const NUM_ITEMS = 5;
const firstPageItems = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
const secondPageItems = [{ id: "f" }, { id: "g" }, { id: "h" }, { id: "i" }, { id: "j" }];

const pushByArgs = (fake: FakeClient, args: Record<string, unknown>, value: PaginationResult<{ id: string }>): void => {
    const key = JSON.stringify(args);

    for (const sub of fake.subscriptions) {
        if (JSON.stringify(sub.args) === key && !sub.unsubscribed) {
            sub.push(value);
        }
    }
};

describe(paginatedQuery, () => {
    it("first page loads and results flatten", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { results, status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(status()).toBe("LoadingFirstPage");
        expect(results()).toStrictEqual([]);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("CanLoadMore");
        expect(results()).toStrictEqual(firstPageItems);
    });

    it("loadMore appends a second page", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { loadMore, results, status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("CanLoadMore");

        loadMore(NUM_ITEMS);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );

        expect(results()).toStrictEqual([...firstPageItems, ...secondPageItems]);
        expect(status()).toBe("Exhausted");
    });

    it("skip short-circuits to LoadingFirstPage with no subscriptions", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { isLoading, status } = paginatedQuery(fn, "skip", { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(status()).toBe("LoadingFirstPage");
        expect(fake.subscriptions).toHaveLength(0);
        // `status` alone is "LoadingFirstPage" for a skipped feed, so a spinner
        // bound to `isLoading` would never stop — React's `!skipped` contract.
        expect(isLoading()).toBe(false);
    });

    it("last page reports Exhausted", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { status } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: firstPageItems,
            },
        );

        expect(status()).toBe("Exhausted");
    });

    it("a page error surfaces on `error`, returns status to CanLoadMore, and lets loadMore retry", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const errors: SubscriptionError[] = [];

        const { error, isLoading, loadMore, results, status } = paginatedQuery(
            fn,
            {},
            {
                client: fake.asClient,
                destroyRef: destroy.asDestroyRef,
                initialNumItems: NUM_ITEMS,
                onError: (e) => errors.push(e),
            },
        );

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: "cur-1", isDone: false, page: firstPageItems },
        );

        loadMore(NUM_ITEMS);

        expect(status()).toBe("LoadingMore");

        // An RLS denial on the new page: pending was cleared but the feed sat in
        // `LoadingMore` forever with `isLoading` true and nothing surfaced.
        const tailArgs = { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS };
        const tail = fake.subscriptions.find((sub) => JSON.stringify(sub.args) === JSON.stringify({ paginationOpts: tailArgs }));

        tail?.emitError({ code: "FORBIDDEN", message: "denied" });

        expect(errors).toStrictEqual([{ code: "FORBIDDEN", message: "denied" }]);
        expect(error()).toStrictEqual({ code: "FORBIDDEN", message: "denied" });
        expect(status()).toBe("CanLoadMore");
        expect(isLoading()).toBe(false);
        expect(results()).toStrictEqual(firstPageItems);
        expect(tail?.unsubscribed).toBe(true);

        // The failed tail was dropped, so `loadMore` re-opens exactly that range.
        const before = fake.subscriptions.length;

        loadMore(NUM_ITEMS);

        expect(error()).toBeUndefined();
        expect(status()).toBe("LoadingMore");
        expect(fake.subscriptions.slice(before).map((sub) => sub.args["paginationOpts"])).toStrictEqual([tailArgs]);
    });

    it("tears down all subscriptions on destroy", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions.every((sub) => sub.unsubscribed)).toBe(true);
    });
});

// Plan 285 — converge on `stableWireKey` for page keys instead of raw
// `JSON.stringify`.
//
// Open Question 1 (answered by reading `usePaginatedCore`): `narrowedArgs`
// (the base args `buildPageArgs` spreads under `paginationOpts`) is a `const`
// captured once per `paginatedQuery`/`infiniteQuery` call and never rebuilt —
// so within a SINGLE engine instance, `buildPageKey`'s output is deterministic
// and property order never drifts across the calls this file makes (the args
// come from one fixed object every time). The plan's headline "duplicate
// subscriptions" / "result-carry miss" consequences are about TWO SEPARATE
// component instances whose args are structurally equal but built with
// different property order — that collapses (or doesn't) at the underlying
// `client.subscribe` / `SubscriptionRegistry` dedup layer, which already uses
// `stableWireKey` (per plan 285 §1) and is external to this adapter's own
// bookkeeping; this package's fake `LunoraClient` doesn't model that dedup, so
// there is no reachable pre/post-fix difference to assert for the
// permutation/result-carry scenarios via this file's harness (Test plan items
// 1–2's own downgrade allowance). The wire-typed-arg test below is the
// reachable, demonstrably pre/post-fix-differentiating case.
describe("paginatedQuery — stableWireKey page keys (plan 285)", () => {
    const bigintArgFn = { __lunoraRef: "messages:list" } as FunctionReference<"query", { since: bigint }>;
    const permutableArgFn = { __lunoraRef: "messages:list" } as FunctionReference<"query", { a: number; b: number }>;

    it("accepts a bigint in the query args without throwing (wire-typed arg)", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        // Pre-fix, `buildPageKey` used raw `JSON.stringify`, which throws
        // `TypeError: Do not know how to serialize a BigInt` the instant a
        // page's args carry a `bigint` — this call would never complete.
        // Post-fix, `stableWireKey` tokenizes it deterministically instead.
        expect(() => {
            paginatedQuery(bigintArgFn, { since: 10n }, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });
        }).not.toThrow();

        expect(fake.subscriptions).toHaveLength(1);
    });

    it("subscribes normally when caller args are not in canonical key order", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { status } = paginatedQuery(
            permutableArgFn,
            { a: 2, b: 1 },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS },
        );

        expect(fake.subscriptions).toHaveLength(1);
        expect(status()).toBe("LoadingFirstPage");
    });
});

/**
 * A `LunoraClient` stand-in whose `subscribe` replays a preseeded cached value
 * to the new subscriber SYNCHRONOUSLY — the callback fires before `subscribe`
 * returns, exactly like the real client (lunora-client.ts replays `lastValue`
 * before handing back the unsubscribe handle). This is the trigger for the
 * reentrant-`syncSubscriptions` bug the guard fixes.
 */
interface ReplaySub {
    args: Record<string, unknown>;
    key: string;
    push: (value: unknown) => void;
    unsubscribed: boolean;
}

const createReplayFake = (): { asClient: LunoraClient; cache: Map<string, unknown>; subs: ReplaySub[] } => {
    const subs: ReplaySub[] = [];
    const cache = new Map<string, unknown>();

    const client = {
        subscribe: (_function: FunctionReference, args: Record<string, unknown>, callback: (value: unknown) => void) => {
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

    return { asClient: client as unknown as LunoraClient, cache, subs };
};

describe("paginatedQuery reentrancy", () => {
    it("reentrant rebalance during a synchronous cached replay does not orphan or duplicate page subscriptions", () => {
        const fake = createReplayFake();
        const destroy = createFakeDestroyRef();

        const numItems = 2; // SPLIT_FACTOR (2) × numItems = 4 → a 5-item page splits.
        const { loadMore } = paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: numItems });

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

        // Every handle is tracked: destroy tears them all down, none orphaned.
        destroy.destroy();

        expect(fake.subs.every((sub) => sub.unsubscribed)).toBe(true);
    });
});

describe(infiniteQuery, () => {
    it("first page loads as first page array", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { isLoading, pages } = infiniteQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        expect(isLoading()).toBe(true);
        expect(pages()).toStrictEqual([]);

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        expect(isLoading()).toBe(false);
        expect(pages()).toStrictEqual([firstPageItems]);
    });

    it("fetchNextPage appends second page array", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const { fetchNextPage, pages } = infiniteQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS });

        pushByArgs(
            fake,
            { paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: "cur-1",
                isDone: false,
                page: firstPageItems,
            },
        );

        fetchNextPage();

        pushByArgs(
            fake,
            { paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            {
                continueCursor: null,
                isDone: true,
                page: secondPageItems,
            },
        );

        expect(pages()).toStrictEqual([firstPageItems, secondPageItems]);
    });
});

/**
 * Wraps `client.subscribe` with an order log of `subscribe:<args>` /
 * `unsubscribe:<args>` entries, in call order — the direct way to prove
 * teardown-before-reopen (not just "eventually true after the fact"), without
 * touching the shared `fake-client.ts` helper.
 */
const trackSubscribeOrder = (client: LunoraClient): string[] => {
    const events: string[] = [];
    const original = client.subscribe.bind(client);

    vi.spyOn(client, "subscribe").mockImplementation((...callArgs: Parameters<typeof original>) => {
        const argsKey = JSON.stringify(callArgs[1]);

        events.push(`subscribe:${argsKey}`);

        const unsubscribe = original(...callArgs);

        return () => {
            events.push(`unsubscribe:${argsKey}`);
            unsubscribe();
        };
    });

    return events;
};

// `fn` is untyped (`FunctionReference` with no generic args), so its
// `PaginatedArgs<F>` resolves to an empty object — every other describe block
// in this file only ever passes `{}`. The reactive-args tests need an actual
// arg field to vary, so they use this typed reference instead.
const roomFn = { __lunoraRef: "messages:list" } as FunctionReference<"query", { roomId: string }>;

describe("paginatedQuery — reactive args (plan 340)", () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    });

    afterEach(() => {
        TestBed.resetTestingModule();
    });

    it("disposes the current pagination engine and builds a fresh one when the args source changes — teardown BEFORE the new page subscription opens", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const events = trackSubscribeOrder(fake.asClient);
        const injector = TestBed.inject(Injector);
        const roomId = signal("room-a");

        const firstArgs = { roomId: "room-a", paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } };
        const secondArgs = { roomId: "room-b", paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } };

        const { results, status } = paginatedQuery(
            roomFn,
            () => {
                return { roomId: roomId() };
            },
            {
                client: fake.asClient,
                destroyRef: destroy.asDestroyRef,
                initialNumItems: NUM_ITEMS,
                injector,
            },
        );

        // The effect's first run is scheduled, not synchronous with creation —
        // flush it before asserting the initial engine/page subscription opened.
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual(firstArgs);

        fake.subscriptions[0]?.push({ continueCursor: "cur-1", isDone: false, page: firstPageItems });

        expect(results()).toStrictEqual(firstPageItems);

        roomId.set("room-b");
        TestBed.tick();

        // The precise ordering proof: the old page subscription's `unsubscribe`
        // fires BEFORE the new one is opened for the new args — not just
        // "both eventually happened".
        expect(events).toStrictEqual([
            `subscribe:${JSON.stringify(firstArgs)}`,
            `unsubscribe:${JSON.stringify(firstArgs)}`,
            `subscribe:${JSON.stringify(secondArgs)}`,
        ]);

        // A whole fresh engine, not a re-keyed one: back to `LoadingFirstPage`
        // with empty results, not the old room's carried-over data.
        expect(status()).toBe("LoadingFirstPage");
        expect(results()).toStrictEqual([]);

        expect(fake.subscriptions).toHaveLength(2);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
        expect(fake.subscriptions[1]?.unsubscribed).toBe(false);
        expect(fake.subscriptions[1]?.args).toStrictEqual(secondArgs);

        fake.subscriptions[1]?.push({ continueCursor: "cur-2", isDone: false, page: secondPageItems });

        expect(results()).toStrictEqual(secondPageItems);
    });

    it("a static args value builds the pagination engine exactly once and never rebuilds it, even as unrelated signals tick", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const unrelated = signal(0);

        paginatedQuery(fn, {}, { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS, injector });

        expect(fake.subscriptions).toHaveLength(1);

        unrelated.set(1);
        TestBed.tick();
        unrelated.set(2);
        TestBed.tick();

        // If the static form were accidentally routed through the reactive
        // dispose-and-rebuild path, ticks would eventually rebuild the engine;
        // it must be a no-op here.
        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);
    });

    it("'skip' opens nothing; switching from 'skip' to real args builds exactly one engine", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const args = signal<{ roomId: string } | "skip">("skip");

        const { status } = paginatedQuery(roomFn, () => args(), {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            initialNumItems: NUM_ITEMS,
            injector,
        });

        expect(status()).toBe("LoadingFirstPage");
        expect(fake.subscriptions).toHaveLength(0);

        args.set({ roomId: "room-a" });
        TestBed.tick();

        expect(fake.subscriptions).toHaveLength(1);
        expect(fake.subscriptions[0]?.args).toStrictEqual({ roomId: "room-a", paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } });
    });

    it("loadMore on the reactive form appends a page and survives the next effect flush", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const roomId = signal("room-a");

        const { loadMore, results, status } = paginatedQuery(
            roomFn,
            () => {
                return { roomId: roomId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS, injector },
        );

        TestBed.tick();

        pushByArgs(
            fake,
            { roomId: "room-a", paginationOpts: { cursor: null, endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: "cur-1", isDone: false, page: firstPageItems },
        );

        expect(status()).toBe("CanLoadMore");

        loadMore(NUM_ITEMS);

        pushByArgs(
            fake,
            { roomId: "room-a", paginationOpts: { cursor: "cur-1", endCursor: null, numItems: NUM_ITEMS } },
            { continueCursor: null, isDone: true, page: secondPageItems },
        );

        expect(results()).toStrictEqual([...firstPageItems, ...secondPageItems]);

        // The regression: `loadMore` writes the engine's `pages` signal. If the
        // engine were built INSIDE the tracked part of the reactive effect, that
        // write would be one of the effect's dependencies — so the next flush
        // would dispose the generation and rebuild it from `initialNumItems`,
        // silently snapping the feed back to page one.
        TestBed.tick();

        expect(status()).toBe("Exhausted");
        expect(results()).toStrictEqual([...firstPageItems, ...secondPageItems]);
    });

    it("destroy tears down the reactive-form engine's subscriptions", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const roomId = signal("room-a");

        paginatedQuery(
            roomFn,
            () => {
                return { roomId: roomId() };
            },
            { client: fake.asClient, destroyRef: destroy.asDestroyRef, initialNumItems: NUM_ITEMS, injector },
        );
        TestBed.tick();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        destroy.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });
});
