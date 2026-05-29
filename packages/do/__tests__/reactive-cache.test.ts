import { describe, expect, test } from "vitest";

import { createDependencyTracker, depKey, SCAN_DEP } from "../src/dependency-tracker.js";
import { ReactiveCache, reactiveCacheKey, stableStringify } from "../src/reactive-cache.js";

/**
 * Standalone tests for the reactive-cache primitive — kept framework-agnostic
 * so the cache contract can evolve without dragging the shard-do harness
 * along. Integration with ctx-db hooks and the WS subscription bridge lives
 * in `reactive-cache.integration.test.ts`.
 */
describe("dependencyTracker", () => {
    test("recordRead stamps (table, id) and (table, scan) keys", () => {
        const tracker = createDependencyTracker();

        tracker.recordRead("users", "u1");
        tracker.recordRead("users", SCAN_DEP);
        tracker.recordRead("messages", "m1");

        expect([...tracker.collect()]).toEqual(["users:u1", "users:*scan", "messages:m1"]);
    });

    test("collect returns a stable reference (caller can hand to cache)", () => {
        const tracker = createDependencyTracker();
        const first = tracker.collect();

        tracker.recordRead("users", "u1");

        const second = tracker.collect();

        expect(second).toBe(first);
        expect([...second]).toEqual(["users:u1"]);
    });

    test("recording the same key twice is idempotent", () => {
        const tracker = createDependencyTracker();

        tracker.recordRead("users", "u1");
        tracker.recordRead("users", "u1");

        expect(tracker.collect().size).toBe(1);
    });
});

describe("stableStringify", () => {
    test("encodes object keys in lexical order regardless of input order", () => {
        expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    });

    test("treats { a: undefined } the same as {}", () => {
        expect(stableStringify({ a: undefined })).toBe(stableStringify({}));
    });

    test("encodes nested structures stably", () => {
        const left = stableStringify({ user: { name: "alice", id: "u1" }, limit: 10 });
        const right = stableStringify({ limit: 10, user: { id: "u1", name: "alice" } });

        expect(left).toBe(right);
    });
});

describe("reactiveCacheKey", () => {
    test("combines function path with stable args encoding", () => {
        expect(reactiveCacheKey("messages:list", { channelId: "A", limit: 10 })).toBe(reactiveCacheKey("messages:list", { limit: 10, channelId: "A" }));
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
        run,
        get calls() {
            return calls;
        },
    };
};

describe("reactiveCache", () => {
    test("cache hit: same key returns memoized result without re-running the handler", async () => {
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

    test("row-id invalidation: invalidate(table, id) drops entries that read that id", async () => {
        const cache = new ReactiveCache();
        const spy = spyCounter();

        await cache.run("users:get:u1", new Set([depKey("users", "u1")]), spy.run);
        cache.invalidate("users", "u1");
        const fresh = await cache.run("users:get:u1", new Set([depKey("users", "u1")]), spy.run);

        expect(spy.calls).toBe(2);
        expect(fresh).toBe(2);
    });

    test("scan invalidation: any write to a table blows *scan entries on it", async () => {
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

    test("independence: invalidating one table does not blow entries on another", async () => {
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

    test("invalidateTable nukes both per-id and *scan entries on the table", async () => {
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

    test("lRU eviction: filling past maxEntries drops the oldest entry", async () => {
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

    test("lRU eviction respects recency: touching k1 saves it from eviction", async () => {
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

    test("subscribed entries pin against LRU eviction", async () => {
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

    test("args sensitivity: same function, different args = different cache slots", async () => {
        const cache = new ReactiveCache();
        const spy = spyCounter();

        await cache.run(reactiveCacheKey("messages:list", { channelId: "A" }), new Set([depKey("messages", SCAN_DEP)]), spy.run);
        await cache.run(reactiveCacheKey("messages:list", { channelId: "B" }), new Set([depKey("messages", SCAN_DEP)]), spy.run);

        expect(spy.calls).toBe(2);
        expect(cache.size().entries).toBe(2);
    });

    test("rLS interaction: restrictsCounts/baseWhere bake into the cache key via argsHash", () => {
        const restricted = reactiveCacheKey("messages:count", { restrictsCounts: true, baseWhere: { ownerId: "u1" } });
        const unrestricted = reactiveCacheKey("messages:count", {});

        expect(restricted).not.toBe(unrestricted);
    });

    test("subscribers(): snapshot returns a defensive copy", async () => {
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

    test("subscribers() returns [] for unknown keys (no entry pinned yet)", () => {
        const cache = new ReactiveCache();

        cache.subscribe("never-cached", "sub-a");

        expect(cache.subscribers("never-cached")).toEqual([]);
    });

    test("invalidate returns the list of removed keys for the bridge to iterate", async () => {
        const cache = new ReactiveCache();

        await cache.run("a", new Set([depKey("t", "1")]), async () => 1);
        await cache.run("b", new Set([depKey("t", "1")]), async () => 2);
        await cache.run("c", new Set([depKey("t", "2")]), async () => 3);

        const removed = cache.invalidate("t", "1");

        expect(removed.toSorted()).toEqual(["a", "b"]);
        expect(cache.size().entries).toBe(1);
    });

    test("size reports cumulative byte charge across entries", async () => {
        const cache = new ReactiveCache();

        await cache.run("k1", new Set(), async () => "hello");
        await cache.run("k2", new Set(), async () => ({ a: 1 }));

        // "hello" -> JSON "\"hello\"" length 7; { a: 1 } -> JSON length 7.
        expect(cache.size().bytes).toBe(14);
        expect(cache.size().entries).toBe(2);
    });

    test("clear() empties all entries and indexes", async () => {
        const cache = new ReactiveCache();

        await cache.run("k1", new Set([depKey("t", "1")]), async () => 1);
        cache.clear();

        expect(cache.size()).toEqual({ entries: 0, bytes: 0 });

        // After clear, the same key re-runs.
        let calls = 0;

        await cache.run("k1", new Set([depKey("t", "1")]), async () => {
            calls += 1;

            return 10;
        });

        expect(calls).toBe(1);
    });
});
