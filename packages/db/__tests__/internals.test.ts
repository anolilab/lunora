/* eslint-disable no-underscore-dangle -- `_id` is the Lunora document-id field; test fixtures mirror it verbatim */
import { NonRetriableError } from "@tanstack/offline-transactions";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OutboxExecutor, OutboxMutationMetadata, Row, SyncWriter } from "../src/internals";
import { createExecutorOutboxSink, createOptimisticOnlineDetector, makeDiffEmit, OUTBOX_MUTATION_FN_NAME, runOutboxMutation, toMap } from "../src/internals";

/**
 * A fake `OfflineExecutor` slice: every `createOfflineTransaction(...).mutate()`
 * appends a persisted entry; `peekOutbox` returns them oldest-first and
 * `removeFromOutbox` evicts by id. Records the metadata each transaction carried
 * so the sink's persisted payload can be asserted.
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
            peekOutbox: () => Promise.resolve([...outbox]),
            removeFromOutbox: (id) => {
                const index = outbox.findIndex((entry) => entry.id === id);

                if (index !== -1) {
                    outbox.splice(index, 1);
                }

                return Promise.resolve();
            },
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
            identity: "ident-a",
            mutationId: 1,
            shardKey: "room-7",
        });
    });

    it("evicts the oldest persisted writes once the cap is exceeded, reporting each drop", async () => {
        const { executor, outbox } = fakeExecutor();
        const dropped: string[] = [];
        const sink = createExecutorOutboxSink(executor, { maxItems: 2, onOverflow: (id) => dropped.push(id) });

        await sink.enqueue(outboxMutation(1));
        await sink.enqueue(outboxMutation(2));

        // Still within the cap — nothing evicted yet.
        expect(dropped).toStrictEqual([]);

        await sink.enqueue(outboxMutation(3));

        // The third write pushes over the cap → the oldest (tx-1) is evicted.
        expect(dropped).toStrictEqual(["tx-1"]);
        expect(outbox.map((entry) => entry.id)).toStrictEqual(["tx-2", "tx-3"]);
    });

    it("uses the configured reserved mutationFn name", async () => {
        const seen: string[] = [];
        const executor: OutboxExecutor = {
            createOfflineTransaction: (options) => {
                seen.push(options.mutationFnName);

                return { mutate: () => undefined };
            },
            getPendingCount: () => 0,
            peekOutbox: () => Promise.resolve([]),
            removeFromOutbox: () => Promise.resolve(),
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
        const synced = new Map<string, Row>();
        const { ops, writer } = recordingWriter();
        const emit = makeDiffEmit(synced, writer);

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
        expect(synced.size).toBe(2);

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
        const synced = new Map<string, Row>();
        const { ops, writer } = recordingWriter();
        const emit = makeDiffEmit(synced, writer);
        const snapshot = (): Map<string, Row> => toMap([{ _id: "a", text: "1" }] satisfies Row[], (r) => r._id);

        emit(snapshot());
        ops.length = 0;
        emit(snapshot());

        expect(ops).toStrictEqual([]);
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
        const rejected = Object.assign(new Error("duplicate name"), { code: "CONFLICT" });

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
