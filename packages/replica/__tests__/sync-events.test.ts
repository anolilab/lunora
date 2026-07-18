import { describe, expect, it, vi } from "vitest";

import type { EventLogEntry } from "../src/event-log";
import { EventLog } from "../src/event-log";
import type { LocalMirror } from "../src/local-mirror";
import { EventsSync } from "../src/sync-events";
import type { TableDiff } from "../src/table-diff";
import { createTableDiff } from "../src/table-diff";

// ─── Helpers ──────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Create a mock LocalMirror that records applied diffs in memory.
 */
const createMockMirror = (): {
    applied: TableDiff[];
    mirror: LocalMirror;
} => {
    const applied: TableDiff[] = [];

    const mirror = {
        applyDiff: vi.fn((diff: TableDiff) => {
            applied.push(diff);
        }),
        onChange: vi.fn(),
        get eventLog(): EventLog {
            return new EventLog();
        },
    } as unknown as LocalMirror;

    return { mirror, applied };
};

/**
 * Seed a few events into an in-memory log and return a fetch function
 * that serves them page by page, tracking the `sinceSeq` calls.
 */
const createMockLog = (
    entries: EventLogEntry[],
): {
    callCount: () => number;
    fetchEventsSince: (sinceSeq: number) => Promise<ReadonlyArray<EventLogEntry>>;
    lastSinceSeq: () => number;
} => {
    let callCount = 0;
    let lastSinceSeq = 0;

    const fetchEventsSince = async (sinceSeq: number): Promise<ReadonlyArray<EventLogEntry>> => {
        callCount += 1;
        lastSinceSeq = sinceSeq;

        return entries.filter((e) => e.seq >= sinceSeq);
    };

    return { fetchEventsSince, callCount: () => callCount, lastSinceSeq: () => lastSinceSeq };
};

// ─── Tests ─────────────────────────────────────────────────────────────────

describe(EventsSync, () => {
    it("starts with watermark 0", () => {
        const { mirror } = createMockMirror();
        const sync = new EventsSync({
            fetchEventsSince: () => Promise.resolve([]),
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
        });

        expect(sync.watermark).toBe(0);
    });

    it("sync() fetches events and advances watermark", async () => {
        const { mirror } = createMockMirror();
        const { fetchEventsSince, callCount } = createMockLog([
            { seq: 0, type: "event.a", payload: { x: 1 }, timestamp: 100 },
            { seq: 1, type: "event.b", payload: { y: 2 }, timestamp: 200 },
        ]);

        const applied: EventLogEntry[] = [];

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: (events) => {
                applied.push(...events);
            },
            getTableDiffs: () => [],
            mirror,
        });

        const count = await sync.sync();

        expect(count).toBe(2);
        expect(applied).toHaveLength(2);
        expect(applied[0]!.seq).toBe(0);
        expect(applied[1]!.seq).toBe(1);
        expect(sync.watermark).toBe(2); // seq 0 + 1 + 1
        expect(callCount()).toBe(1);
    });

    it("sync() applies diffs to the mirror", async () => {
        const { mirror, applied } = createMockMirror();
        const { fetchEventsSince } = createMockLog([{ seq: 0, type: "event.a", payload: { val: "hello" }, timestamp: 100 }]);

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: () => {},
            getTableDiffs: () => [createTableDiff("items", [{ type: "insert", data: { id: "1", name: "hello" } }])],
            mirror,
        });

        await sync.sync();

        expect(applied).toHaveLength(1);
        expect(applied[0]!.table).toBe("items");
        expect(applied[0]!.changes).toHaveLength(1);
        expect(applied[0]!.changes[0]).toEqual({
            type: "insert",
            data: { id: "1", name: "hello" },
        });
    });

    it("sync() returns 0 when there are no new events", async () => {
        const { mirror } = createMockMirror();
        const { fetchEventsSince } = createMockLog([]);

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
        });

        const count = await sync.sync();

        expect(count).toBe(0);
        expect(sync.watermark).toBe(0);
    });

    it("sync() does not advance watermark when fetch throws", async () => {
        const { mirror } = createMockMirror();

        const sync = new EventsSync({
            fetchEventsSince: () => Promise.reject(new Error("network error")),
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            onError: () => {}, // suppress console.error
        });

        const count = await sync.sync();

        expect(count).toBe(0);
        expect(sync.watermark).toBe(0);
    });

    it("sync() does not advance watermark when applyEvents throws", async () => {
        const { mirror } = createMockMirror();
        const { fetchEventsSince } = createMockLog([{ seq: 0, type: "err", payload: null, timestamp: 100 }]);

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: () => {
                throw new Error("apply failed");
            },
            getTableDiffs: () => [],
            mirror,
            onError: () => {},
        });

        const count = await sync.sync();

        expect(count).toBe(0);
        expect(sync.watermark).toBe(0);
    });

    it("start() begins polling and stop() halts it", async () => {
        vi.useFakeTimers();

        const { mirror } = createMockMirror();
        // Return empty after first call to keep the test deterministic
        let callIndex = 0;

        const sync = new EventsSync({
            fetchEventsSince: async () => {
                callIndex += 1;
                return [];
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            pollInterval: 1000,
        });

        sync.start();

        // Should have first timer enqueued
        expect(callIndex).toBe(0);

        // Advance past first interval
        await vi.advanceTimersByTimeAsync(1000);

        expect(callIndex).toBe(1);

        // Advance past second interval
        await vi.advanceTimersByTimeAsync(1000);

        expect(callIndex).toBe(2);

        sync.stop();

        // Advance past third interval — should not fire
        await vi.advanceTimersByTimeAsync(1000);

        expect(callIndex).toBe(2); // still 2

        vi.useRealTimers();
    });

    it("start() is idempotent", () => {
        const { mirror } = createMockMirror();

        const sync = new EventsSync({
            fetchEventsSince: () => Promise.resolve([]),
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            pollInterval: 1000,
        });

        sync.start();
        sync.start(); // second call should no-op
        sync.stop();
    });

    it("stop() is safe when not started", () => {
        const { mirror } = createMockMirror();

        const sync = new EventsSync({
            fetchEventsSince: () => Promise.resolve([]),
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
        });

        expect(() => {
            sync.stop();
        }).not.toThrow();
    });

    it("prevents overlapping poll cycles", async () => {
        const { mirror } = createMockMirror();
        let activeCalls = 0;
        let maxConcurrent = 0;

        const sync = new EventsSync({
            fetchEventsSince: async () => {
                activeCalls += 1;
                maxConcurrent = Math.max(maxConcurrent, activeCalls);
                // Simulate a slow fetch
                await new Promise((r) => setTimeout(r, 50));
                activeCalls -= 1;
                return [];
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            onError: () => {},
            pollInterval: 10,
        });

        // Trigger two syncs concurrently
        await Promise.all([sync.sync(), sync.sync()]);

        // Only one should have been active at a time
        expect(maxConcurrent).toBe(1);
    });

    it("calls onError when fetch fails", async () => {
        const { mirror } = createMockMirror();
        const onError = vi.fn();

        const sync = new EventsSync({
            fetchEventsSince: () => Promise.reject(new Error("boom")),
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            onError,
        });

        await sync.sync();

        expect(onError).toHaveBeenCalledTimes(1);

        const error = onError.mock.calls[0]![0] as Error;

        expect(error.message).toBe("boom");
    });

    it("callbacks are invoked with correct watermark progression", async () => {
        const { mirror, applied } = createMockMirror();

        // Two pages of events
        let page = 0;

        const sync = new EventsSync({
            fetchEventsSince: async (sinceSeq) => {
                if (page === 0) {
                    page += 1;
                    return [
                        { seq: 0, type: "a", payload: null, timestamp: 10 },
                        { seq: 1, type: "b", payload: null, timestamp: 20 },
                    ];
                }
                if (page === 1 && sinceSeq === 2) {
                    page += 1;
                    return [{ seq: 2, type: "c", payload: null, timestamp: 30 }];
                }
                return [];
            },
            applyEvents: () => {},
            getTableDiffs: () => [createTableDiff("t", [{ type: "insert", data: { id: String(page) } }])],
            mirror,
        });

        // First sync → events seq 0-1 → watermark 2
        const count1 = await sync.sync();

        expect(count1).toBe(2);
        expect(sync.watermark).toBe(2);
        expect(applied).toHaveLength(1);

        // Second sync → event seq 2 → watermark 3
        const count2 = await sync.sync();

        expect(count2).toBe(1);
        expect(sync.watermark).toBe(3);
        expect(applied).toHaveLength(2);

        // Third sync → no new events
        const count3 = await sync.sync();

        expect(count3).toBe(0);
        expect(sync.watermark).toBe(3);
        expect(applied).toHaveLength(2);
    });

    // REPLICA-08 ──────────────────────────────────────────────────────────

    it("a mid-batch applyEvents failure advances the watermark only past the successful prefix — no double-apply on the next poll", async () => {
        const { mirror } = createMockMirror();
        const { fetchEventsSince } = createMockLog([
            { seq: 0, type: "ok", payload: "a", timestamp: 10 },
            { seq: 1, type: "ok", payload: "b", timestamp: 20 },
            { seq: 2, type: "boom", payload: "c", timestamp: 30 },
            { seq: 3, type: "ok", payload: "d", timestamp: 40 },
        ]);

        const appliedPayloads: unknown[] = [];

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: (events) => {
                for (const event of events) {
                    if (event.type === "boom") {
                        throw new Error("apply failed mid-batch");
                    }

                    appliedPayloads.push(event.payload);
                }
            },
            getTableDiffs: () => [],
            mirror,
            onError: () => {},
        });

        // First poll: applies seq 0, 1, then throws on seq 2. seq 3 is never
        // reached this cycle (loop stops at the first failure).
        const count1 = await sync.sync();

        expect(count1).toBe(2);
        expect(sync.watermark).toBe(2); // stopped right after the last successful event
        expect(appliedPayloads).toStrictEqual(["a", "b"]);

        // Second poll re-fetches from watermark 2 — seq 0/1 must NOT be
        // re-applied (that would be the double-apply bug). It hits "boom"
        // again immediately (seq 2), so nothing new applies this cycle either.
        const count2 = await sync.sync();

        expect(count2).toBe(0);
        expect(sync.watermark).toBe(2);
        expect(appliedPayloads).toStrictEqual(["a", "b"]); // unchanged — no re-application of a/b
    });

    it("sync() awaits an in-flight poll instead of no-op'ing for a concurrent call", async () => {
        const { mirror } = createMockMirror();
        let resolveFetch: ((entries: EventLogEntry[]) => void) | undefined;
        let fetchCalls = 0;

        const sync = new EventsSync({
            fetchEventsSince: async () => {
                fetchCalls += 1;

                return new Promise<EventLogEntry[]>((resolve) => {
                    resolveFetch = resolve;
                });
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
        });

        const first = sync.sync();
        const second = sync.sync();

        // The second call must not start its own fetch cycle — it awaits the
        // one already in flight (REPLICA-08), not return 0 immediately.
        expect(fetchCalls).toBe(1);

        resolveFetch?.([{ seq: 0, type: "a", payload: null, timestamp: 10 }]);

        const [firstCount, secondCount] = await Promise.all([first, second]);

        expect(firstCount).toBe(1);
        // Both callers observe the SAME outcome — the real result of the one
        // cycle that ran — not a synthetic `0`.
        expect(secondCount).toBe(1);
        expect(fetchCalls).toBe(1);
    });
});
