/* eslint-disable no-underscore-dangle -- `_id` is the Cirrus document-id field; test fixtures mirror it verbatim */
import { NonRetriableError } from "@tanstack/offline-transactions";
import { describe, expect, it } from "vitest";

import type { Row, SyncWriter } from "../src/internals";
import { makeDiffEmit, runOutboxMutation, toMap } from "../src/internals";

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

    it("wraps a server rejection in NonRetriableError so the optimistic insert rolls back", async () => {
        await expect(runOutboxMutation(() => Promise.reject(new Error("duplicate name")))).rejects.toBeInstanceOf(NonRetriableError);
    });

    it("resolves quietly on success", async () => {
        await expect(runOutboxMutation(() => Promise.resolve("ok"))).resolves.toBeUndefined();
    });
});
