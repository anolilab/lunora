import { describe, expect, it } from "vitest";

import { diffExternalSource } from "../src/external-source-diff";

/**
 * Pure full-pull ingest diff (plan 077). Mirrors the `shape-global-diff` tests:
 * empty-baseline seed, insert/update/delete delta, unchanged no-op, and column
 * projection — but the output is the writer-side `CdcChange[]` (op/id/table/doc)
 * rather than client poke-ops.
 */

describe(diffExternalSource, () => {
    it("treats a diff against an empty baseline as an all-insert seed", () => {
        expect.assertions(2);

        const { changes, nextBaseline } = diffExternalSource(
            [
                { _id: "d1", title: "a" },
                { _id: "d2", title: "b" },
            ],
            new Map(),
            { table: "documents" },
        );

        expect(changes).toStrictEqual([
            { doc: { _id: "d1", title: "a" }, id: "d1", op: "insert", seq: 0, table: "documents", ts: 0 },
            { doc: { _id: "d2", title: "b" }, id: "d2", op: "insert", seq: 0, table: "documents", ts: 0 },
        ]);
        // The returned baseline is what the next tick diffs from.
        expect([...nextBaseline]).toStrictEqual([
            ["d1", JSON.stringify({ _id: "d1", title: "a" })],
            ["d2", JSON.stringify({ _id: "d2", title: "b" })],
        ]);
    });

    it("emits insert / update / delete for the delta and skips unchanged rows", () => {
        expect.assertions(1);

        const baseline = new Map<string, string>([
            ["d1", JSON.stringify({ _id: "d1", title: "a" })],
            ["d2", JSON.stringify({ _id: "d2", title: "b" })],
            ["d4", JSON.stringify({ _id: "d4", title: "d" })],
        ]);

        // d1 unchanged, d2 changed, d3 new upstream, d4 vanished upstream.
        const { changes } = diffExternalSource(
            [
                { _id: "d1", title: "a" },
                { _id: "d2", title: "b2" },
                { _id: "d3", title: "c" },
            ],
            baseline,
            { table: "documents" },
        );

        expect(changes).toStrictEqual([
            { doc: { _id: "d2", title: "b2" }, id: "d2", op: "update", seq: 0, table: "documents", ts: 0 },
            { doc: { _id: "d3", title: "c" }, id: "d3", op: "insert", seq: 0, table: "documents", ts: 0 },
            { id: "d4", op: "delete", seq: 0, table: "documents", ts: 0 },
        ]);
    });

    it("returns no changes when membership is unchanged", () => {
        expect.assertions(2);

        const baseline = new Map<string, string>([["d1", JSON.stringify({ _id: "d1", title: "a" })]]);

        const { changes, nextBaseline } = diffExternalSource([{ _id: "d1", title: "a" }], baseline, { table: "documents" });

        expect(changes).toStrictEqual([]);
        // The baseline is reproduced so the loop can advance to it even on a no-op tick.
        expect([...nextBaseline]).toStrictEqual([["d1", JSON.stringify({ _id: "d1", title: "a" })]]);
    });

    it("diffs projected values so an out-of-column change is invisible", () => {
        expect.assertions(1);

        // Only `title` is projected; a change confined to `secret` is a no-op.
        const baseline = new Map<string, string>([["d1", JSON.stringify({ _id: "d1", title: "a" })]]);

        const { changes } = diffExternalSource([{ _id: "d1", secret: "changed", title: "a" }], baseline, {
            columns: ["title"],
            table: "documents",
        });

        expect(changes).toStrictEqual([]);
    });

    it("projects upserted documents to the column allow-list (plus _id)", () => {
        expect.assertions(2);

        const { changes } = diffExternalSource([{ _id: "d1", body: "drop-me", title: "keep" }], new Map(), {
            columns: ["title"],
            table: "documents",
        });

        const [change] = changes;

        expect(change).toMatchObject({ id: "d1", op: "insert", table: "documents" });
        // `projectColumns` returns a null-prototype object (prototype-pollution safe);
        // spread into a plain object so the structural check ignores the prototype.
        expect({ ...change?.doc }).toStrictEqual({ _id: "d1", title: "keep" });
    });

    it("carries no document on a delete", () => {
        expect.assertions(1);

        const baseline = new Map<string, string>([["d1", JSON.stringify({ _id: "d1", title: "a" })]]);

        const { changes } = diffExternalSource([], baseline, { table: "documents" });

        expect(changes).toStrictEqual([{ id: "d1", op: "delete", seq: 0, table: "documents", ts: 0 }]);
    });
});
