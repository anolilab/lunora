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
        applyDiff: vi.fn<(diff: TableDiff) => void>((diff) => {
            applied.push(diff);
        }),
        onChange: vi.fn<() => () => void>(),
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
        expect.assertions(1);

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
        expect.assertions(6);

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
        // Two fetches: the batch, then the one that comes back empty and ends
        // the catch-up walk.
        expect(callCount()).toBe(2);
    });

    it("sync() walks every page of a log larger than one batch", async () => {
        expect.assertions(4);

        const { mirror } = createMockMirror();

        const log: EventLogEntry[] = Array.from({ length: 5 }, (_, index) => {
            return { seq: index, type: "e", payload: index, timestamp: 100 + index };
        });

        // A transport that answers a BOUNDED page, like `EventLogDOClient.getSince`.
        const pageSize = 2;
        const batches: number[][] = [];

        const sync = new EventsSync({
            fetchEventsSince: (sinceSeq) => Promise.resolve(log.filter((entry) => entry.seq >= sinceSeq).slice(0, pageSize)),
            applyEvents: (events) => {
                batches.push(events.map((entry) => entry.seq));
            },
            getTableDiffs: () => [],
            mirror,
        });

        const count = await sync.sync();

        expect(count).toBe(5);
        expect(sync.watermark).toBe(5);
        // Each page is applied as its own atom — never one 5-event batch.
        expect(batches).toStrictEqual([[0, 1], [2, 3], [4]]);
        await expect(sync.sync()).resolves.toBe(0);
    });

    it("sync() stops instead of spinning when a batch does not advance the watermark", async () => {
        expect.assertions(2);

        const { mirror } = createMockMirror();
        let calls = 0;

        const sync = new EventsSync({
            // A broken transport: always the same entry, whatever the watermark.
            fetchEventsSince: () => {
                calls += 1;

                return Promise.resolve([{ seq: 0, type: "stuck", payload: null, timestamp: 1 }]);
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
        });

        await sync.sync();
        await sync.sync();

        expect(sync.watermark).toBe(1);
        // Cycle 1: the batch, then one more fetch that returns the SAME entry —
        // it ends at seq 0 < the watermark, so the walk stops. Cycle 2: one
        // fetch, same verdict. Bounded, not spinning.
        expect(calls).toBe(3);
    });

    it("sync() applies diffs to the mirror", async () => {
        expect.assertions(4);

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
        expect.assertions(2);

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
        expect.assertions(2);

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
        expect.assertions(2);

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
        expect.assertions(4);

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

    it("start() is idempotent", async () => {
        expect.assertions(1);

        vi.useFakeTimers();

        const { mirror } = createMockMirror();
        let calls = 0;

        const sync = new EventsSync({
            fetchEventsSince: async () => {
                calls += 1;

                return [];
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            pollInterval: 1000,
        });

        sync.start();
        sync.start(); // second call should no-op

        await vi.advanceTimersByTimeAsync(1000);
        sync.stop();

        // One timer, not two: the second `start()` did not arm a second poll loop.
        expect(calls).toBe(1);

        vi.useRealTimers();
    });

    it("stop() is safe when not started", () => {
        expect.assertions(1);

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
        expect.assertions(1);

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
        expect.assertions(2);

        const { mirror } = createMockMirror();
        const onError = vi.fn<(error: unknown) => void>();

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
        expect.assertions(6);

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

        // One sync walks BOTH pages (seq 0-1, then seq 2) and lands on
        // watermark 3. A clean page takes the fast path: ONE `getTableDiffs()`
        // + ONE mirror fan-out per page (REPLICA-08 batched catch-up), so two
        // diffs land for three events — not one per event.
        const count1 = await sync.sync();

        expect(count1).toBe(3);
        expect(sync.watermark).toBe(3);
        expect(applied).toHaveLength(2);

        // Second sync → no new events.
        const count2 = await sync.sync();

        expect(count2).toBe(0);
        expect(sync.watermark).toBe(3);
        expect(applied).toHaveLength(2);
    });

    // REPLICA-08 ──────────────────────────────────────────────────────────

    it("a mid-batch applyEvents failure does NOT advance the watermark — the next poll retries the whole batch from a clean state", async () => {
        expect.assertions(6);

        const { mirror } = createMockMirror();
        const { fetchEventsSince } = createMockLog([
            { seq: 0, type: "ok", payload: "a", timestamp: 10 },
            { seq: 1, type: "ok", payload: "b", timestamp: 20 },
            { seq: 2, type: "boom", payload: "c", timestamp: 30 },
            { seq: 3, type: "ok", payload: "d", timestamp: 40 },
        ]);

        let failOnBoom = true;
        const appliedPayloads: unknown[] = [];

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: (events) => {
                for (const event of events) {
                    if (event.type === "boom" && failOnBoom) {
                        throw new Error("apply failed mid-batch");
                    }

                    appliedPayloads.push(event.payload);
                }
            },
            getTableDiffs: () => [],
            mirror,
            onError: () => {},
        });

        // First poll: the whole batch is driven as ONE atom. applyEvents pushes
        // "a", "b", then throws on seq 2 ("boom"). Because the batch threw, the
        // watermark is NOT advanced — it stays 0 — and the poll reports 0
        // applied. Nothing was committed; the next poll retries from scratch.
        const count1 = await sync.sync();

        expect(count1).toBe(0);
        expect(sync.watermark).toBe(0); // never advances past an un-committed batch
        expect(appliedPayloads).toStrictEqual(["a", "b"]);

        // The transient failure clears; the next poll re-fetches the SAME batch
        // from watermark 0 and now succeeds end to end. No event is skipped —
        // the whole batch (including the earlier suffix "c"/"d") is delivered.
        failOnBoom = false;

        const count2 = await sync.sync();

        expect(count2).toBe(4);
        expect(sync.watermark).toBe(4);
        expect(appliedPayloads).toStrictEqual(["a", "b", "a", "b", "c", "d"]);
    });

    it("a clean batch takes the fast path — ONE diff + ONE mirror round for the whole backlog", async () => {
        expect.assertions(4);

        const { mirror, applied } = createMockMirror();
        const backlog: EventLogEntry[] = Array.from({ length: 25 }, (_, index) => ({
            seq: index,
            type: "ok",
            payload: index,
            timestamp: index * 10,
        }));
        const { fetchEventsSince } = createMockLog(backlog);

        let diffCalls = 0;

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: () => {},
            getTableDiffs: () => {
                diffCalls += 1;

                return [createTableDiff("items", [{ type: "insert", data: { id: "batch" } }])];
            },
            mirror,
            onError: () => {},
        });

        const count = await sync.sync();

        expect(count).toBe(25);
        expect(sync.watermark).toBe(25);
        // The whole 25-event backlog produced exactly ONE `getTableDiffs` call
        // and ONE mirror write — not 25 of each.
        expect(diffCalls).toBe(1);
        expect(applied).toHaveLength(1);
    });

    it("stateful recompute getTableDiffs: a mid-batch mirror throw strands NO diffs — the watermark holds, the next poll delivers exactly the remainder", async () => {
        expect.assertions(6);

        // This is the coverage gap the old suite missed: a STATEFUL,
        // recompute-from-current-state `getTableDiffs`. Under the documented
        // idempotent contract, a mid-batch mirror failure must lose nothing —
        // the retry re-derives only the diffs still missing from the mirror.
        const sourceRows = new Set<string>();
        const mirroredRows: string[] = [];

        const events: EventLogEntry[] = Array.from({ length: 4 }, (_, index) => ({
            seq: index,
            type: "add",
            payload: `row${index}`,
            timestamp: index * 10,
        }));
        const { fetchEventsSince } = createMockLog(events);

        // The mirror throws on its 3rd applyDiff call (the first poll), then
        // recovers once `failAt` is cleared.
        let applyCalls = 0;
        let failAt: number | undefined = 3;

        const mirror = {
            applyDiff: vi.fn<(diff: TableDiff) => void>((diff) => {
                applyCalls += 1;

                if (applyCalls === failAt) {
                    throw new Error("mirror write failed");
                }

                for (const change of diff.changes) {
                    if (change.type === "insert") {
                        mirroredRows.push((change.data as { id: string }).id);
                    }
                }
            }),
            onChange: vi.fn<() => () => void>(),
            get eventLog(): EventLog {
                return new EventLog();
            },
        } as unknown as LocalMirror;

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: (batch) => {
                for (const event of batch) {
                    sourceRows.add(event.payload as string);
                }
            },
            // IDEMPOTENT recompute: one insert diff per source row still missing
            // from the mirror. No cursor — recomputed fresh from current state
            // on every call, so calling it again after a partial mirror write
            // returns exactly the diffs that did not land.
            getTableDiffs: () =>
                [...sourceRows].filter((row) => !mirroredRows.includes(row)).map((row) => createTableDiff("rows", [{ type: "insert", data: { id: row } }])),
            mirror,
            onError: () => {},
        });

        // First poll: applyEvents records all 4 source rows, getTableDiffs emits
        // 4 insert diffs, and the mirror throws on the 3rd. The watermark is NOT
        // advanced and only the first 2 rows landed in the mirror.
        const count1 = await sync.sync();

        expect(count1).toBe(0);
        expect(sync.watermark).toBe(0);
        expect(mirroredRows).toStrictEqual(["row0", "row1"]);

        // The mirror recovers; the next poll re-fetches the SAME batch,
        // recomputes ONLY the still-missing diffs (row2, row3) — no re-insert of
        // row0/row1 — and delivers them. Nothing was permanently lost, and the
        // watermark advances past the batch only once the mirror is whole.
        failAt = undefined;

        const count2 = await sync.sync();

        expect(count2).toBe(4);
        expect(sync.watermark).toBe(4);
        expect(mirroredRows).toStrictEqual(["row0", "row1", "row2", "row3"]);
    });

    it("does NOT replay a batch through applyEvents when only the mirror fan-out failed", async () => {
        expect.assertions(4);

        // The replay succeeded; the mirror threw afterwards. The watermark holds
        // (correctly — the diffs are not mirrored yet), so the next poll re-fetches
        // the same batch. Handing it to the state machine again applies the same
        // events twice, and unlike `getTableDiffs`, `applyEvents` is not required
        // to be idempotent and has nothing to roll back.
        const applied: unknown[] = [];
        const { fetchEventsSince } = createMockLog([
            { seq: 0, type: "ok", payload: "a", timestamp: 10 },
            { seq: 1, type: "ok", payload: "b", timestamp: 20 },
        ]);

        let failMirror = true;

        const mirror = {
            applyDiff: vi.fn<(diff: TableDiff) => void>(() => {
                if (failMirror) {
                    throw new Error("mirror write failed");
                }
            }),
            onChange: vi.fn<() => () => void>(),
            get eventLog(): EventLog {
                return new EventLog();
            },
        } as unknown as LocalMirror;

        const sync = new EventsSync({
            fetchEventsSince,
            applyEvents: (events) => {
                for (const event of events) {
                    applied.push(event.payload);
                }
            },
            getTableDiffs: () => [createTableDiff("rows", [{ type: "insert", data: { id: "x" } }])],
            mirror,
            onError: () => {},
        });

        await sync.sync();

        expect(applied).toStrictEqual(["a", "b"]);
        expect(sync.watermark).toBe(0);

        failMirror = false;

        const count = await sync.sync();

        // The retry re-derives the diffs (that is `getTableDiffs`' idempotency
        // contract) but must not re-run the state machine over "a" and "b".
        expect(applied).toStrictEqual(["a", "b"]);
        expect(count).toBe(2);
    });

    it("yields a poll cycle instead of chasing a log that keeps growing", async () => {
        expect.assertions(3);

        const { mirror } = createMockMirror();

        // A writer faster than the reader: every fetch answers with one more
        // event, so the batch is never empty. Against a genuinely live log an
        // unbounded cycle never returns at all — and `#inFlight`, which every
        // concurrent `sync()` awaits, never settles. The writer stops here at
        // 1500 only so an unbounded loop terminates and reports the overrun
        // instead of hanging the suite.
        const sync = new EventsSync({
            fetchEventsSince: async (sinceSeq) => {
                return sinceSeq >= 1500 ? [] : [{ seq: sinceSeq, type: "ok", payload: sinceSeq, timestamp: sinceSeq }];
            },
            applyEvents: () => {},
            getTableDiffs: () => [],
            mirror,
            onError: () => {},
        });

        const count = await sync.sync();

        expect(count).toBe(1000);
        // The watermark carries the cycle's progress, so the next one resumes
        // exactly where this stopped rather than repeating any of it.
        expect(sync.watermark).toBe(1000);

        await expect(sync.sync()).resolves.toBe(500);
    });

    it("sync() awaits an in-flight poll instead of no-op'ing for a concurrent call", async () => {
        expect.assertions(4);

        const { mirror } = createMockMirror();
        let resolveFetch: ((entries: EventLogEntry[]) => void) | undefined;
        let fetchCalls = 0;

        const sync = new EventsSync({
            fetchEventsSince: async () => {
                fetchCalls += 1;

                // The catch-up walk's terminating fetch — only the FIRST call
                // is the one this test parks in flight.
                if (fetchCalls > 1) {
                    return [];
                }

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
        // The parked fetch plus the walk's terminating one — the second
        // `sync()` still started no cycle of its own.
        expect(fetchCalls).toBe(2);
    });
});
