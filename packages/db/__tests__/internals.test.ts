import { LunoraError } from "@lunora/errors";
import { NonRetriableError } from "@tanstack/offline-transactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxExecutor, OutboxMutationMetadata, Row, SyncWriter } from "../src/internals";
import { createExecutorOutboxSink, createOptimisticOnlineDetector, makeDiffEmit, OUTBOX_MUTATION_FN_NAME, runOutboxMutation, toMap } from "../src/internals";

/**
 * A fake `OfflineExecutor` slice: every `createOfflineTransaction(...).mutate()`
 * appends a persisted entry and `getPendingCount` reports the depth. Records the
 * metadata each transaction carried so the sink's persisted payload can be asserted.
 */
const fakeExecutor = (): { committed: OutboxMutationMetadata[]; executor: OutboxExecutor; outbox: { id: string }[] } => {
    const outbox: { id: string }[] = [];
    const committed: OutboxMutationMetadata[] = [];
    let counter = 0;

    return {
        committed,
        executor: {
            createOfflineTransaction: (options) => {
                return {
                    mutate: () => {
                        counter += 1;
                        outbox.push({ id: `tx-${counter.toString()}` });
                        committed.push(options.metadata as OutboxMutationMetadata);
                    },
                };
            },
            getPendingCount: () => outbox.length,
        },
        outbox,
    };
};

const outboxMutation = (mutationId: number) => {
    return {
        args: { text: `m${mutationId.toString()}` },
        clientId: "c1",
        functionPath: "messages:send",
        idempotencyKey: `c1:${mutationId.toString()}`,
        identity: "ident-a",
        mutationId,
    };
};

describe(createExecutorOutboxSink, () => {
    it("persists each write as an executor transaction carrying the replay metadata", async () => {
        const { committed, executor, outbox } = fakeExecutor();
        const sink = createExecutorOutboxSink(executor);

        await sink.enqueue({ ...outboxMutation(1), shardKey: "room-7" });

        expect(outbox).toHaveLength(1);
        expect(committed[0]).toStrictEqual({
            args: { text: "m1" },
            clientId: "c1",
            functionPath: "messages:send",
            idempotencyKey: "c1:1",
            identity: "ident-a",
            mutationId: 1,
            shardKey: "room-7",
        });
    });

    it("rejects with OFFLINE_QUEUE_OVERFLOW at capacity instead of evicting", async () => {
        const { executor, outbox } = fakeExecutor();
        const sink = createExecutorOutboxSink(executor, { maxItems: 2 });

        await sink.enqueue(outboxMutation(1));
        await sink.enqueue(outboxMutation(2));

        // At capacity — the next write is rejected, and no persisted write is dropped.
        await expect(sink.enqueue(outboxMutation(3))).rejects.toMatchObject({ code: "OFFLINE_QUEUE_OVERFLOW" });
        expect(outbox.map((entry) => entry.id)).toStrictEqual(["tx-1", "tx-2"]);
    });

    it("uses the configured reserved mutationFn name", async () => {
        const seen: string[] = [];
        const executor: OutboxExecutor = {
            createOfflineTransaction: (options) => {
                seen.push(options.mutationFnName);

                return { mutate: () => undefined };
            },
            getPendingCount: () => 0,
        };

        await createExecutorOutboxSink(executor).enqueue(outboxMutation(1));

        expect(seen).toStrictEqual([OUTBOX_MUTATION_FN_NAME]);
    });
});

/** A SyncWriter that records the writes it received, in order. */
const recordingWriter = (): { ops: ({ key: string; type: "delete" } | { type: "insert" | "update"; value: Row })[]; writer: SyncWriter<Row> } => {
    const ops: ({ key: string; type: "delete" } | { type: "insert" | "update"; value: Row })[] = [];

    return {
        ops,
        writer: {
            begin: () => {},
            commit: () => {},
            write: (message) => ops.push(message),
        },
    };
};

describe(makeDiffEmit, () => {
    it("emits only the rows that changed between snapshots", () => {
        // syncedJson is the single Map<string, string> cache owned at the caller level.
        const syncedJson = new Map<string, string>();
        const { ops, writer } = recordingWriter();
        const emit = makeDiffEmit(syncedJson, writer);

        // First snapshot: two inserts.
        emit(
            toMap(
                [
                    { _id: "a", text: "1" },
                    { _id: "b", text: "2" },
                ] satisfies Row[],
                (r) => r._id,
            ),
        );

        expect(ops).toStrictEqual([
            { type: "insert", value: { _id: "a", text: "1" } },
            { type: "insert", value: { _id: "b", text: "2" } },
        ]);
        expect(syncedJson.size).toBe(2);

        // Second snapshot: `a` changed, `b` removed, `c` added.
        ops.length = 0;
        emit(
            toMap(
                [
                    { _id: "a", text: "CHANGED" },
                    { _id: "c", text: "3" },
                ] satisfies Row[],
                (r) => r._id,
            ),
        );

        expect(ops).toStrictEqual([
            { type: "update", value: { _id: "a", text: "CHANGED" } },
            { type: "insert", value: { _id: "c", text: "3" } },
            { key: "b", type: "delete" },
        ]);
    });

    it("writes nothing when the snapshot is unchanged", () => {
        const syncedJson = new Map<string, string>();
        const { ops, writer } = recordingWriter();
        const emit = makeDiffEmit(syncedJson, writer);
        const snapshot = (): Map<string, Row> => toMap([{ _id: "a", text: "1" }] satisfies Row[], (r) => r._id);

        emit(snapshot());
        ops.length = 0;
        emit(snapshot());

        expect(ops).toStrictEqual([]);
    });

    it("does not emit spurious updates for unchanged rows across emit closures sharing one cache", () => {
        // The map, not the closure, is the unit of synced state: a second
        // `makeDiffEmit` over the same populated map sees already-committed rows
        // as known. NOT a simulation of the sync-RESTART path — the sole
        // production caller clears the map in its `sync.sync` teardown (a
        // restart must re-insert the full snapshot, since TanStack drops its
        // synced store on gc cleanup). That lifecycle is covered end to end by
        // `collection-options.test.ts`'s "re-inserts the full snapshot after a
        // sync restart", which drives the real `sync.sync` seam.
        const syncedJson = new Map<string, string>();
        const { ops: ops1, writer: writer1 } = recordingWriter();

        // First sync session: two rows arrive.
        const emit1 = makeDiffEmit(syncedJson, writer1);
        emit1(
            toMap(
                [
                    { _id: "a", text: "hello" },
                    { _id: "b", text: "world" },
                ] satisfies Row[],
                (r) => r._id,
            ),
        );

        expect(ops1).toStrictEqual([
            { type: "insert", value: { _id: "a", text: "hello" } },
            { type: "insert", value: { _id: "b", text: "world" } },
        ]);
        expect(syncedJson.size).toBe(2);

        // A new writer (and therefore a new emit closure) over the same
        // syncedJson — the committed state must be preserved.
        const { ops: ops2, writer: writer2 } = recordingWriter();
        const emit2 = makeDiffEmit(syncedJson, writer2);

        // Server re-delivers the same rows (identical snapshot after reconnect).
        // No writes should be emitted — they are NOT new or changed.
        emit2(
            toMap(
                [
                    { _id: "a", text: "hello" },
                    { _id: "b", text: "world" },
                ] satisfies Row[],
                (r) => r._id,
            ),
        );

        expect(ops2).toStrictEqual([]);
    });

    it("correctly detects a change on the first emit through a new closure", () => {
        // A row whose value actually changed must still emit "update" when the
        // next emit comes from a different closure over the same cache.
        const syncedJson = new Map<string, string>();
        const { writer: writer1 } = recordingWriter();
        const emit1 = makeDiffEmit(syncedJson, writer1);

        emit1(toMap([{ _id: "a", text: "v1" }] satisfies Row[], (r) => r._id));

        // New writer/closure, same syncedJson.
        const { ops: ops2, writer: writer2 } = recordingWriter();
        const emit2 = makeDiffEmit(syncedJson, writer2);

        emit2(toMap([{ _id: "a", text: "v2" }] satisfies Row[], (r) => r._id));

        expect(ops2).toStrictEqual([{ type: "update", value: { _id: "a", text: "v2" } }]);
    });
});

describe(runOutboxMutation, () => {
    it("rethrows a network failure (TypeError) so the outbox retries it", async () => {
        const error = new TypeError("Failed to fetch");

        await expect(
            runOutboxMutation(() => {
                throw error;
            }),
        ).rejects.toBe(error);
    });

    it("rethrows a code-less transient HTTP failure so the outbox retries it", async () => {
        // e.g. a 5xx gateway page / non-JSON body the rpc surfaces without a code.
        const error = new Error("LunoraClient: response was not JSON (status 502)");

        await expect(
            runOutboxMutation(() => {
                throw error;
            }),
        ).rejects.toBe(error);
    });

    it("wraps a coded server rejection in NonRetriableError so the optimistic insert rolls back", async () => {
        const rejected = new LunoraError("CONFLICT", "duplicate name");

        await expect(runOutboxMutation(() => Promise.reject(rejected))).rejects.toBeInstanceOf(NonRetriableError);
    });

    it("resolves quietly on success", async () => {
        await expect(runOutboxMutation(() => Promise.resolve("ok"))).resolves.toBeUndefined();
    });
});

describe(createOptimisticOnlineDetector, () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("each subscribe call gets its own independent interval", () => {
        expect.assertions(4);

        const detector = createOptimisticOnlineDetector();
        const callsA: number[] = [];
        const callsB: number[] = [];

        const unsubA = detector.subscribe(() => {
            callsA.push(Date.now());
        });
        detector.subscribe(() => {
            callsB.push(Date.now());
        });

        // Advance past a tick — both should fire.
        vi.advanceTimersByTime(5000);

        expect(callsA.length).toBeGreaterThan(0);
        expect(callsB.length).toBeGreaterThan(0);

        // Unsubscribe A; B must keep firing but A must stop.
        unsubA();
        const countABefore = callsA.length;
        const countBBefore = callsB.length;

        vi.advanceTimersByTime(5000);

        expect(callsA).toHaveLength(countABefore);
        expect(callsB.length).toBeGreaterThan(countBBefore);

        detector.dispose();
    });

    it("dispose() stops all remaining intervals", () => {
        expect.assertions(2);

        const detector = createOptimisticOnlineDetector();
        const callsA: number[] = [];
        const callsB: number[] = [];

        detector.subscribe(() => {
            callsA.push(Date.now());
        });
        detector.subscribe(() => {
            callsB.push(Date.now());
        });

        detector.dispose();

        const countA = callsA.length;
        const countB = callsB.length;

        vi.advanceTimersByTime(10_000);

        expect(callsA).toHaveLength(countA);
        expect(callsB).toHaveLength(countB);
    });
});
