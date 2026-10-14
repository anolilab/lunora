import { describe, expect, it } from "vitest";

import { createDependencyTracker, depKey, SCAN_DEP } from "../src/dependency-tracker";
import { ReactiveCache, reactiveCacheKey, stableStringify } from "../src/reactive-cache";

/**
 * Standalone tests for the reactive-cache primitive — kept framework-agnostic
 * so the cache contract can evolve without dragging the shard-do harness
 * along. Integration with ctx-db hooks and the WS subscription bridge lives
 * in `reactive-cache.integration.test.ts`.
 */
describe("dependencyTracker", () => {
    it("recordRead stamps (table, id) and (table, scan) keys", () => {
        expect.assertions(1);

        const tracker = createDependencyTracker();

        tracker.recordRead("users", "u1");
        tracker.recordRead("users", SCAN_DEP);
        tracker.recordRead("messages", "m1");

        expect([...tracker.collect()]).toEqual(["users:u1", "users:*scan", "messages:m1"]);
    });

    it("collect returns a stable reference (caller can hand to cache)", () => {
        expect.assertions(2);

        const tracker = createDependencyTracker();
        const first = tracker.collect();

        tracker.recordRead("users", "u1");

        const second = tracker.collect();

        expect(second).toBe(first);
        expect([...second]).toEqual(["users:u1"]);
    });

    it("recording the same key twice is idempotent", () => {
        expect.assertions(1);

        const tracker = createDependencyTracker();

        tracker.recordRead("users", "u1");
        tracker.recordRead("users", "u1");

        expect(tracker.collect().size).toBe(1);
    });
});

describe("stableStringify", () => {
    it("encodes object keys in lexical order regardless of input order", () => {
        expect.assertions(1);

        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    });

    it("treats { a: undefined } the same as {}", () => {
        expect.assertions(1);

        expect(stableStringify({ a: undefined })).toBe(stableStringify({}));
    });

    it("encodes nested structures stably", () => {
        expect.assertions(1);

        const left = stableStringify({ limit: 10, user: { id: "u1", name: "alice" } });
        const right = stableStringify({ limit: 10, user: { id: "u1", name: "alice" } });

        expect(left).toBe(right);
    });
});

describe("reactiveCacheKey", () => {
    it("combines function path with stable args encoding", () => {
        expect.assertions(1);

        expect(reactiveCacheKey("messages:list", { channelId: "A", limit: 10 }, null)).toBe(
            reactiveCacheKey("messages:list", { channelId: "A", limit: 10 }, null),
        );
    });

    it("scopes the key to caller identity so users never collide", () => {
        expect.assertions(3);

        const a = reactiveCacheKey("profile:me", {}, "user_a");
        const b = reactiveCacheKey("profile:me", {}, "user_b");
        const anon = reactiveCacheKey("profile:me", {}, null);

        expect(a).not.toBe(b);
        expect(a).not.toBe(anon);
        expect(b).not.toBe(anon);
    });

    it("folds identity claims into the discriminator so the same userId with different claims never collides", () => {
        // Guards the encoder step that `runCachedQuery` performs before it
        // reaches `reactiveCacheKey`: it folds the FULL identity (userId AND
        // the `getIdentity()` claims RLS can key on) through `stableStringify`,
        // not the userId alone. A stable userId whose active-org claim varies
        // request-to-request must therefore produce distinct discriminators,
        // which in turn keys distinct cache entries.
        expect.assertions(2);

        const orgA = stableStringify({ claims: { activeOrgId: "A" }, userId: "u1" });
        const orgB = stableStringify({ claims: { activeOrgId: "B" }, userId: "u1" });

        expect(orgA).not.toBe(orgB);
        // The claim-bearing discriminator must also differ from the bare-userId
        // one, so widening the key can never alias onto a legacy userId-only slot.
        expect(orgA).not.toBe(stableStringify({ claims: null, userId: "u1" }));
    });

    it("keys wire-typed args (bigint / Date / bytes) without throwing, distinct per value", () => {
        // Decode-at-entry (plan 090) hands the reactive layer REAL decoded values,
        // so the cache key must tokenize them: two subscriptions whose args differ
        // only by a bigint/Date/bytes value need DISTINCT entries — a collision
        // here would cross-feed one subscriber's rows to the other.
        expect.assertions(4);

        expect(() => reactiveCacheKey("q", { since: 123n }, null)).not.toThrow();
        expect(reactiveCacheKey("q", { since: 123n }, null)).not.toBe(reactiveCacheKey("q", { since: 124n }, null));
        expect(reactiveCacheKey("q", { at: new Date(1000) }, null)).not.toBe(reactiveCacheKey("q", { at: new Date(2000) }, null));
        expect(reactiveCacheKey("q", { blob: new Uint8Array([1]).buffer }, null)).not.toBe(reactiveCacheKey("q", { blob: new Uint8Array([2]).buffer }, null));
    });

    it("keeps pure-JSON args byte-identical to the pre-wire-key format", () => {
        expect.assertions(1);

        // `stableWireKey` is identity for pure JSON, so the key-namespace change
        // invalidated no existing entry (and client/DO keys stay aligned). The
        // NUL separators are the key format's real (unambiguous) delimiters.
        expect(reactiveCacheKey("q", { b: 2, a: 1 }, null)).toBe(`\u0000anon\u0000q:${stableStringify({ a: 1, b: 2 })}`);
    });
});

/**
 * Shared spy factory: returns a closure plus a `calls` counter. Pulled into
 * the describe scope to keep the per-test arrange step short and to satisfy
 * sonarjs/no-identical-functions (otherwise three tests would each inline
 * the same counter pattern).
 */
const spyCounter = (returnValue?: unknown) => {
    let calls = 0;
    const run = async (): Promise<unknown> => {
        calls += 1;

        return returnValue ?? calls;
    };

    return {
        get calls() {
            return calls;
        },
        run,
    };
};

describe("reactiveCache", () => {
    it("cache hit: same key returns memoized result without re-running the handler", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        let calls = 0;

        const run = async () => {
            calls += 1;

            return { rows: ["r1"] };
        };

        const a = await cache.run("messages:list:{}", new Set(["messages:r1"]), run);
        const b = await cache.run("messages:list:{}", new Set(["messages:r1"]), run);

        expect(calls).toBe(1);
        expect(b).toEqual(a);
    });

    it("row-id invalidation: invalidate(table, id) drops entries that read that id", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        const spy = spyCounter();

        await cache.run("users:get:u1", new Set([depKey("users", "u1")]), spy.run);
        cache.invalidate("users", "u1");
        const fresh = await cache.run("users:get:u1", new Set([depKey("users", "u1")]), spy.run);

        expect(spy.calls).toBe(2);
        expect(fresh).toBe(2);
    });

    it("scan invalidation: any write to a table blows *scan entries on it", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        const spy = spyCounter();

        await cache.run("users:list:{}", new Set([depKey("users", SCAN_DEP)]), spy.run);
        // A write to a row id we never read — but it's the same table, so the
        // scan dep MUST invalidate (a new row could change the scan's answer).
        cache.invalidate("users", "u-unseen");
        const fresh = await cache.run("users:list:{}", new Set([depKey("users", SCAN_DEP)]), spy.run);

        expect(spy.calls).toBe(2);
        expect(fresh).toBe(2);
    });

    it("independence: invalidating one table does not blow entries on another", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        let userCalls = 0;
        let messageCalls = 0;

        await cache.run("users:get:u1", new Set([depKey("users", "u1")]), async () => {
            userCalls += 1;

            return userCalls;
        });

        await cache.run("messages:list:{}", new Set([depKey("messages", "m1")]), async () => {
            messageCalls += 1;

            return messageCalls;
        });

        cache.invalidate("users", "u1");

        // messages entry survives.
        const messageHit = await cache.run("messages:list:{}", new Set([depKey("messages", "m1")]), async () => {
            messageCalls += 1;

            return messageCalls;
        });

        expect(messageCalls).toBe(1);
        expect(messageHit).toBe(1);
    });

    it("invalidateTable nukes both per-id and *scan entries on the table", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        let scanCalls = 0;
        let getCalls = 0;

        await cache.run("u:list", new Set([depKey("users", SCAN_DEP)]), async () => {
            scanCalls += 1;

            return scanCalls;
        });

        await cache.run("u:get:u1", new Set([depKey("users", "u1")]), async () => {
            getCalls += 1;

            return getCalls;
        });

        cache.invalidateTable("users");

        await cache.run("u:list", new Set([depKey("users", SCAN_DEP)]), async () => {
            scanCalls += 1;

            return scanCalls;
        });

        await cache.run("u:get:u1", new Set([depKey("users", "u1")]), async () => {
            getCalls += 1;

            return getCalls;
        });

        expect(scanCalls).toBe(2);
        expect(getCalls).toBe(2);
    });

    it("lRU eviction: filling past maxEntries drops the oldest entry", async () => {
        expect.assertions(3);

        const cache = new ReactiveCache({ maxEntries: 2 });

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        await cache.run("k2", new Set([depKey("t", "2")]), async () => 2);
        await cache.run("k3", new Set([depKey("t", "3")]), async () => 3);

        expect(cache.size().entries).toBe(2);

        // k1 should have been evicted (oldest by lastUsed). A re-run forces a
        // miss; we observe via a fresh call counter.
        let calls = 0;
        const fresh = await cache.run("k1", new Set([depKey("t", "1")]), async () => {
            calls += 1;

            return 10;
        });

        expect(calls).toBe(1);
        expect(fresh).toBe(10);
    });

    it("lRU eviction respects recency: touching k1 saves it from eviction", async () => {
        expect.assertions(1);

        const cache = new ReactiveCache({ maxEntries: 2 });

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        await cache.run("k2", new Set([depKey("t", "2")]), async () => 2);
        // Touch k1 so k2 is now oldest.
        await cache.run("k1", new Set([depKey("t", "1")]), async () => {
            throw new Error("should be cached, never re-run");
        });
        await cache.run("k3", new Set([depKey("t", "3")]), async () => 3);

        // k1 survived; k2 was evicted.
        let k2Calls = 0;

        await cache.run("k2", new Set([depKey("t", "2")]), async () => {
            k2Calls += 1;

            return 20;
        });

        expect(k2Calls).toBe(1);
    });

    it("subscribed entries pin against LRU eviction", async () => {
        expect.assertions(1);

        const cache = new ReactiveCache({ maxEntries: 1 });

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        cache.subscribe("k1", "sub-a");

        // Even though we're past the entry cap, k1 is subscribed and must
        // survive. k2 lands; cache holds both.
        await cache.run("k2", new Set([depKey("t", "2")]), async () => 2);

        let k1Calls = 0;

        await cache.run("k1", new Set([depKey("t", "1")]), async () => {
            k1Calls += 1;

            return 99;
        });

        expect(k1Calls).toBe(0);
    });

    it("args sensitivity: same function, different args = different cache slots", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        const spy = spyCounter();

        await cache.run(reactiveCacheKey("messages:list", { channelId: "A" }, null), new Set([depKey("messages", SCAN_DEP)]), spy.run);
        await cache.run(reactiveCacheKey("messages:list", { channelId: "B" }, null), new Set([depKey("messages", SCAN_DEP)]), spy.run);

        expect(spy.calls).toBe(2);
        expect(cache.size().entries).toBe(2);
    });

    it("rLS interaction: restrictsCounts/baseWhere bake into the cache key via argsHash", () => {
        expect.assertions(1);

        const restricted = reactiveCacheKey("messages:count", { baseWhere: { ownerId: "u1" }, restrictsCounts: true }, null);
        const unrestricted = reactiveCacheKey("messages:count", {}, null);

        expect(restricted).not.toBe(unrestricted);
    });

    it("subscribers(): snapshot returns a defensive copy", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        cache.subscribe("k1", "sub-a");
        cache.subscribe("k1", "sub-b");

        const snapshot = cache.subscribers("k1");

        cache.unsubscribe("k1", "sub-a");

        // Snapshot from before the unsubscribe still has both ids.
        expect(snapshot).toEqual(["sub-a", "sub-b"]);
        expect(cache.subscribers("k1")).toEqual(["sub-b"]);
    });

    it("subscribers() returns [] for unknown keys (no entry pinned yet)", () => {
        expect.assertions(1);

        const cache = new ReactiveCache();

        cache.subscribe("never-cached", "sub-a");

        expect(cache.subscribers("never-cached")).toEqual([]);
    });

    it("invalidate returns the list of removed keys for the bridge to iterate", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();

        await cache.run("a", new Set([depKey("t", "1")]), async () => 1);
        await cache.run("b", new Set([depKey("t", "1")]), async () => 2);
        await cache.run("c", new Set([depKey("t", "2")]), async () => 3);

        const removed = cache.invalidate("t", "1");

        expect(removed.toSorted((a, b) => a.localeCompare(b))).toEqual(["a", "b"]);
        expect(cache.size().entries).toBe(1);
    });

    it("size reports cumulative byte charge across entries", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();

        await cache.run("k1", new Set(), async () => "hello");
        await cache.run("k2", new Set(), async () => {
            return { a: 1 };
        });

        // "hello" -> JSON "\"hello\"" length 7; { a: 1 } -> JSON length 7.
        expect(cache.size().bytes).toBe(14);
        expect(cache.size().entries).toBe(2);
    });

    it("clear() empties all entries and indexes", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        cache.clear();

        expect(cache.size()).toEqual({ bytes: 0, entries: 0 });

        // After clear, the same key re-runs.
        let calls = 0;

        await cache.run("k1", new Set([depKey("t", "1")]), async () => {
            calls += 1;

            return 10;
        });

        expect(calls).toBe(1);
    });

    it("stats() tracks hits, misses, and live entry count", async () => {
        expect.assertions(5);

        const cache = new ReactiveCache();
        const run = async () => {
            return { rows: ["r1"] };
        };

        await cache.run("messages:list:{}", new Set([depKey("messages", "r1")]), run); // miss
        await cache.run("messages:list:{}", new Set([depKey("messages", "r1")]), run); // hit
        await cache.run("users:get:u1", new Set([depKey("users", "u1")]), run); // miss

        const stats = cache.stats();

        expect(stats.hits).toBe(1);
        expect(stats.misses).toBe(2);
        expect(stats.entries).toBe(2);
        expect(stats.evictions).toBe(0);
        expect(stats.bytes).toBeGreaterThan(0);
    });

    it("stats() counts evictions when maxEntries is exceeded", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache({ maxEntries: 1 });
        const run = async () => {
            return { ok: true };
        };

        await cache.run("k1", new Set([depKey("t", "1")]), run);
        await cache.run("k2", new Set([depKey("t", "2")]), run);

        const stats = cache.stats();

        expect(stats.entries).toBe(1);
        expect(stats.evictions).toBe(1);
    });

    // Plan 270: `estimateBytes(result, this.maxBytes)` used to charge an
    // unserializable result the ENTIRE `maxBytes` budget — one such query
    // result would evict every other live entry to make room for a value
    // that could never be meaningfully sized. Declining to memoize is
    // correct instead: run the callback, return the result, store nothing.
    it("does not memoize a result that cannot be serialized, and does not evict live entries to make room for it", async () => {
        expect.assertions(5);

        const cache = new ReactiveCache();

        // A normal entry that must survive the cyclic run below.
        await cache.run("kept", new Set([depKey("t", "kept")]), async () => {
            return { ok: true };
        });

        const statsBefore = cache.stats();

        const cyclic: Record<string, unknown> = {};

        cyclic["self"] = cyclic;

        let calls = 0;
        const runCyclic = async () => {
            calls += 1;

            return cyclic;
        };

        const result = await cache.run("cyclic", new Set([depKey("t", "cyclic")]), runCyclic);

        expect(result).toBe(cyclic);

        const statsAfter = cache.stats();

        // No new entry was stored, and the byte budget is untouched.
        expect(statsAfter.entries).toBe(statsBefore.entries);
        expect(statsAfter.bytes).toBe(statsBefore.bytes);
        expect(statsAfter.evictions).toBe(statsBefore.evictions);

        // A second call with the same key is a miss again — nothing was cached.
        await cache.run("cyclic", new Set([depKey("t", "cyclic")]), runCyclic);

        expect(calls).toBe(2);
    });

    // Regression: two callers race the same key (the documented in-flight
    // duplicate run). The late finisher used to `entries.set` straight over the
    // early one — leaking its byte charge forever (`totalBytes` only ever drops
    // through `dropEntry`), stranding its dep buckets pointing at a key whose
    // entry no longer lists them, and discarding its subscriber pins.
    it("a concurrent second miss on the same key retires the first entry instead of leaking its charge", async () => {
        expect.assertions(4);

        const cache = new ReactiveCache();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        // `slow` enters first but finishes LAST, so it is the one that writes
        // over an entry `quick` already landed.
        const slow = cache.run("k", new Set([depKey("users", "a")]), async () => {
            await gate;

            return { v: 1 };
        });
        const quick = cache.run("k", new Set([depKey("users", "b")]), async () => {
            return { v: 2 };
        });

        await quick;
        release();
        await slow;

        const solo = new ReactiveCache();

        await solo.run("k", new Set([depKey("users", "a")]), async () => {
            return { v: 1 };
        });

        expect(cache.size().entries).toBe(1);
        expect(cache.size().bytes).toBe(solo.size().bytes);
        // The retired entry's dep must no longer name the live key...
        expect(cache.invalidate("users", "b")).toStrictEqual([]);
        // ...while the surviving entry is indexed under its own.
        expect(cache.invalidate("users", "a")).toStrictEqual(["k"]);
    });

    /**
     * Regression: a write that interleaves with a handler's `await` (real I/O —
     * `ctx.fetch`, a `.global()` D1 read, `ctx.runAction`) invalidates a key that
     * has NO entry yet, so it drops nothing and leaves no trace. Storing the
     * handler's pre-write rows afterwards pins them under a key nothing will
     * invalidate again — stale until LRU eviction or a DO restart.
     */
    it("does not memoize a result whose key was invalidated mid-handler, even though there was no entry to drop", async () => {
        expect.assertions(4);

        const cache = new ReactiveCache();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let calls = 0;
        const deps = () => new Set([depKey("users", "u1")]);
        const handler = async () => {
            calls += 1;

            return calls;
        };

        const inFlight = cache.run("users:get:u1", deps(), async () => {
            const value = await handler();

            await gate;

            return value;
        });

        // The mutation lands while the handler is parked: no entry exists for
        // this key yet, so the invalidation removes nothing.
        expect(cache.invalidate("users", "u1")).toStrictEqual([]);

        release();

        // This caller still gets the value it computed — only the STORE is unsafe.
        await expect(inFlight).resolves.toBe(1);
        expect(cache.size().entries).toBe(0);
        // ...so the next call re-runs the handler instead of serving pre-write rows.
        await expect(cache.run("users:get:u1", deps(), handler)).resolves.toBe(2);
    });

    it("does not memoize across a mid-handler invalidateTable", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const inFlight = cache.run("users:list:{}", new Set([depKey("users", SCAN_DEP)]), async () => {
            await gate;

            return ["pre-write"];
        });

        expect(cache.invalidateTable("users")).toStrictEqual([]);

        release();
        await inFlight;

        expect(cache.size().entries).toBe(0);
    });

    it("does not memoize across a mid-handler range invalidation", async () => {
        expect.assertions(2);

        const cache = new ReactiveCache();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const inFlight = cache.run(
            "messages:list:{}",
            new Set<string>(),
            async () => {
                await gate;

                return ["pre-write"];
            },
            () => [{ hi: "c1\u0000\uFFFF", index: "by_channel_seq", lo: "c1\u0000", table: "messages" }],
        );

        // Range-keyed write: it reaches the cache through `dropRangeDeps`, the
        // one invalidation path that never consults `tableIndex`.
        expect(cache.invalidate("messages", "m9", [{ index: "by_channel_seq", key: "c1\u0000005" }])).toStrictEqual([]);

        release();
        await inFlight;

        expect(cache.size().entries).toBe(0);
    });
});
