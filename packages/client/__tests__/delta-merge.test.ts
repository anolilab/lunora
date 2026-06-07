import { describe, expect, it } from "vitest";

import type { MutationDelta } from "../src/delta-merge.js";
import { applyDelta, isMutationDelta } from "../src/delta-merge.js";

const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    return { _id: id, ...extra };
};

describe("isMutationDelta", () => {
    it("accepts a structured row delta", () => {
        expect.assertions(3);

        expect(isMutationDelta({ key: "a", op: "insert", row: row("a"), table: "messages" })).toBe(true);
        expect(isMutationDelta({ key: "a", op: "update", row: row("a"), table: "messages" })).toBe(true);
        expect(isMutationDelta({ key: "a", op: "delete", table: "messages" })).toBe(true);
    });

    it("rejects opaque payloads that lack op/table/key", () => {
        expect.assertions(6);

        // A verbatim aggregate result a query returns — must NOT be treated as a delta.
        expect(isMutationDelta({ count: 1 })).toBe(false);
        expect(isMutationDelta(5)).toBe(false);
        expect(isMutationDelta(0)).toBe(false);
        expect(isMutationDelta(null)).toBe(false);
        expect(isMutationDelta([])).toBe(false);
        expect(isMutationDelta({ key: "a", op: "bogus", table: "m" })).toBe(false);
    });
});

describe("applyDelta", () => {
    it("inserts an absent row, appending when no _creationTime ordering applies", () => {
        expect.assertions(1);

        const current = [row("a"), row("b")];
        const delta: MutationDelta = { key: "c", op: "insert", row: row("c"), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a"), row("b"), row("c")]);
    });

    it("inserts in _creationTime order, preserving sorted position", () => {
        expect.assertions(1);

        const current = [row("a", { _creationTime: 10 }), row("c", { _creationTime: 30 })];
        const delta: MutationDelta = { key: "b", op: "insert", row: row("b", { _creationTime: 20 }), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a", { _creationTime: 10 }), row("b", { _creationTime: 20 }), row("c", { _creationTime: 30 })]);
    });

    it("updates a matching row in place, preserving position", () => {
        expect.assertions(1);

        const current = [row("a", { text: "old" }), row("b", { text: "keep" })];
        const delta: MutationDelta = { key: "a", op: "update", row: row("a", { text: "new" }), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a", { text: "new" }), row("b", { text: "keep" })]);
    });

    it("treats an insert for an already-present id as an in-place update (idempotent, no dup)", () => {
        expect.assertions(1);

        const current = [row("a", { text: "old" })];
        const delta: MutationDelta = { key: "a", op: "insert", row: row("a", { text: "new" }), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a", { text: "new" })]);
    });

    it("deletes a matching row (no loss of the others, order kept)", () => {
        expect.assertions(1);

        const current = [row("a"), row("b"), row("c")];
        const delta: MutationDelta = { key: "b", op: "delete", table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a"), row("c")]);
    });

    it("is a no-op for a delete of a row this page never held", () => {
        expect.assertions(1);

        const current = [row("a"), row("b")];
        const delta: MutationDelta = { key: "z", op: "delete", table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("a"), row("b")]);
    });

    it("does not mutate the input array", () => {
        expect.assertions(2);

        const current = [row("a")];
        const snapshot = [...current];
        const delta: MutationDelta = { key: "b", op: "insert", row: row("b"), table: "messages" };

        const result = applyDelta(current, delta);

        expect(current).toStrictEqual(snapshot);
        expect(result).not.toBe(current);
    });

    it("falls back (undefined) when current isn't an array", () => {
        expect.assertions(2);

        expect(applyDelta({ count: 1 }, { key: "a", op: "insert", row: row("a"), table: "m" })).toBeUndefined();
        expect(applyDelta(undefined, { key: "a", op: "delete", table: "m" })).toBeUndefined();
    });

    it("falls back (undefined) when array elements lack a stable _id", () => {
        expect.assertions(2);

        expect(applyDelta([1, 2, 3], { key: "a", op: "delete", table: "m" })).toBeUndefined();
        expect(applyDelta([{ name: "x" }], { key: "a", op: "delete", table: "m" })).toBeUndefined();
    });

    it("falls back (undefined) for an insert/update with no row body", () => {
        expect.assertions(2);

        expect(applyDelta([row("a")], { key: "b", op: "insert", table: "m" })).toBeUndefined();
        expect(applyDelta([row("a")], { key: "a", op: "update", table: "m" })).toBeUndefined();
    });
});
