import { describe, expect, it } from "vitest";

import type { MutationDelta } from "../src/delta-merge";
import { applyDelta, isMutationDelta } from "../src/delta-merge";

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

    it("inserts a newest row at the FRONT of a descending (newest-first) list", () => {
        expect.assertions(1);

        // A newest-first feed: _creationTime descending. A freshly created row
        // (largest _creationTime) must land at index 0, not be appended to the end.
        const current = [row("c", { _creationTime: 30 }), row("b", { _creationTime: 20 }), row("a", { _creationTime: 10 })];
        const delta: MutationDelta = { key: "d", op: "insert", row: row("d", { _creationTime: 40 }), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([
            row("d", { _creationTime: 40 }),
            row("c", { _creationTime: 30 }),
            row("b", { _creationTime: 20 }),
            row("a", { _creationTime: 10 }),
        ]);
    });

    it("inserts mid-list in a descending list, preserving sorted position", () => {
        expect.assertions(1);

        const current = [row("c", { _creationTime: 30 }), row("a", { _creationTime: 10 })];
        const delta: MutationDelta = { key: "b", op: "insert", row: row("b", { _creationTime: 20 }), table: "messages" };

        expect(applyDelta(current, delta)).toStrictEqual([row("c", { _creationTime: 30 }), row("b", { _creationTime: 20 }), row("a", { _creationTime: 10 })]);
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

    it("falls back (undefined) when current holds no row array", () => {
        expect.assertions(3);

        expect(applyDelta({ count: 1 }, { key: "a", op: "insert", row: row("a"), table: "m" })).toBeUndefined();
        expect(applyDelta(undefined, { key: "a", op: "delete", table: "m" })).toBeUndefined();
        // An object with a `page` that isn't an array is not the paginated shape.
        expect(applyDelta({ page: 3 }, { key: "a", op: "delete", table: "m" })).toBeUndefined();
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

/**
 * `.paginate()` returns `{ page, isDone, continueCursor }`, which is what every
 * `usePaginatedQuery` page holds. Merging into `page` is what lets the server
 * answer a paginated live query with one row delta instead of re-sending the
 * whole page on every write to the table.
 */
describe("applyDelta — paginated results", () => {
    const paginated = (rows: Record<string, unknown>[]): Record<string, unknown> => {
        return { continueCursor: "cursor-2", isDone: false, page: rows };
    };

    it("merges an update into the page and keeps the surrounding fields", () => {
        expect.assertions(1);

        const current = paginated([row("a"), row("b")]);
        const merged = applyDelta(current, { key: "b", op: "update", row: row("b", { text: "edited" }), table: "m" });

        expect(merged).toStrictEqual({ continueCursor: "cursor-2", isDone: false, page: [row("a"), row("b", { text: "edited" })] });
    });

    it("merges an insert and a delete into the page", () => {
        expect.assertions(2);

        expect(applyDelta(paginated([row("a")]), { key: "b", op: "insert", row: row("b"), table: "m" })).toStrictEqual(paginated([row("a"), row("b")]));
        expect(applyDelta(paginated([row("a"), row("b")]), { key: "a", op: "delete", table: "m" })).toStrictEqual(paginated([row("b")]));
    });

    it("never mutates the cached value or its page", () => {
        expect.assertions(3);

        const page = [row("a")];
        const current = paginated(page);
        const snapshot = { continueCursor: "cursor-2", isDone: false, page: [row("a")] };
        const merged = applyDelta(current, { key: "b", op: "insert", row: row("b"), table: "m" });

        expect(current).toStrictEqual(snapshot);
        expect(page).toHaveLength(1);
        expect(merged).not.toBe(current);
    });

    it("falls back (undefined) when the page holds rows without a stable _id", () => {
        expect.assertions(1);

        expect(applyDelta(paginated([{ name: "x" }]), { key: "a", op: "delete", table: "m" })).toBeUndefined();
    });

    it("falls back (undefined) for a non-plain wrapper rather than flattening it", () => {
        expect.assertions(2);

        // Merging re-spreads the wrapper to swap its page, which would turn a
        // class instance into a plain object and quietly change the value's
        // shape. The guard is the wire codec's `isPlainObject`, so the only
        // wrappers accepted are the ones that could have crossed the wire.
        class PageResult {
            public isDone = false;

            public page = [row("a")];
        }

        expect(applyDelta(new PageResult(), { key: "b", op: "insert", row: row("b"), table: "m" })).toBeUndefined();
        // The same fields as a plain object merge normally — the prototype is the only difference.
        expect(applyDelta({ isDone: false, page: [row("a")] }, { key: "b", op: "insert", row: row("b"), table: "m" })).toStrictEqual({
            isDone: false,
            page: [row("a"), row("b")],
        });
    });
});
