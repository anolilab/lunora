/**
 * Characterization tests for `shared/page-result.ts`.
 *
 * This file pins the CURRENT behaviour of `rowListOf` and `insertionIndexFor` —
 * the runtime agreement `@lunora/client` (`delta-merge.ts`) and `@lunora/shard-engine`
 * (`subscription-delivery.ts`) both import by relative path. Per plan 359, this
 * file adds tests only; `shared/page-result.ts` itself must not change here.
 *
 * A few cases below are marked "PINNED, NOT ENDORSED" — the docstring on
 * `page-result.ts` names these as ambiguous (empty list, single-row list, an
 * all-equal `_creationTime` run, a `_creationTime` tie), and the assertions here
 * record what the code does today, not a judgement that it is correct. See the
 * executor report for plan 359 for the write-up.
 */
import { describe, expect, it } from "vitest";

import { CREATION_FIELD, ID_FIELD, insertionIndexFor, rowListOf } from "../../../shared/page-result";

const row = (id: string, creationTime?: number, extra: Record<string, unknown> = {}): Record<string, unknown> => {
    const base: Record<string, unknown> = { [ID_FIELD]: id, ...extra };

    if (creationTime !== undefined) {
        base[CREATION_FIELD] = creationTime;
    }

    return base;
};

describe("rowListOf", () => {
    it("accepts a bare array — the ctx.db.query(...).collect() shape", () => {
        expect.assertions(1);

        const rows = [row("a", 1), row("b", 2)];

        expect(rowListOf(rows)).toBe(rows);
    });

    it("accepts a { page: [...] } wrapper — the .paginate() shape", () => {
        expect.assertions(1);

        const rows = [row("a", 1)];

        expect(rowListOf({ continueCursor: "c1", isDone: false, page: rows })).toBe(rows);
    });

    it("rejects a non-plain-object wrapper even when it carries a page array (isPlainObject guard)", () => {
        expect.assertions(1);

        // A Date instance with an own `page` property: has the right shape but the
        // wrong prototype. If the guard were a bare `typeof === "object"` check this
        // would incorrectly be treated as a paginated result.
        const impostor = Object.assign(new Date(), { page: [row("a", 1)] });

        expect(rowListOf(impostor)).toBeUndefined();
    });

    it("returns undefined for undefined, null, and primitives", () => {
        expect.assertions(5);

        expect(rowListOf(undefined)).toBeUndefined();
        expect(rowListOf(null)).toBeUndefined();
        expect(rowListOf(5)).toBeUndefined();
        expect(rowListOf("x")).toBeUndefined();
        expect(rowListOf({ count: 1 })).toBeUndefined();
    });

    it("returns an empty array for an empty list, in both accepted shapes", () => {
        expect.assertions(2);

        expect(rowListOf([])).toStrictEqual([]);
        expect(rowListOf({ isDone: true, page: [] })).toStrictEqual([]);
    });
});

describe("insertionIndexFor — ascending list", () => {
    const list = [row("a", 10), row("b", 20), row("c", 30)];

    it("inserts before the first larger neighbour — front", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 5))).toBe(0);
    });

    it("inserts before the first larger neighbour — middle", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 15))).toBe(1);
    });

    it("appends when no neighbour is larger — end", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 35))).toBe(3);
    });
});

describe("insertionIndexFor — descending list (newest-first feed)", () => {
    const list = [row("a", 30), row("b", 20), row("c", 10)];

    it("inserts before the first smaller neighbour — front (newest lands first)", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 35))).toBe(0);
    });

    it("inserts before the first smaller neighbour — middle", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 15))).toBe(2);
    });

    it("appends when no neighbour is smaller — end (oldest lands last)", () => {
        expect.assertions(1);

        expect(insertionIndexFor(list, row("new", 5))).toBe(3);
    });
});

describe("insertionIndexFor — ambiguous cases named by the docstring", () => {
    // PINNED, NOT ENDORSED: with zero rows there is no direction to detect.
    // `isDescending([])` returns false (loop body never runs), so the row is
    // simply placed at the only possible index. Unambiguous in effect (0 is the
    // only answer for an empty list either way), so this one is not a finding.
    it("empty list — inserts at index 0", () => {
        expect.assertions(1);

        expect(insertionIndexFor([], row("new", 50))).toBe(0);
    });

    // PINNED, NOT ENDORSED: with exactly one row, `isDescending` cannot observe a
    // direction (the loop sets `previous` once and never compares), so it falls
    // through to its `false` default and the list is treated as ASCENDING. See
    // the executor report: this silently mis-orders an insert into a single-row
    // DESCENDING (newest-first) feed.
    it("single-row list — a smaller new row is inserted before it (ascending assumed)", () => {
        expect.assertions(1);

        expect(insertionIndexFor([row("only", 50)], row("new", 40))).toBe(0);
    });

    it("single-row list — a larger new row is appended after it (ascending assumed)", () => {
        expect.assertions(1);

        // In a genuinely newest-first (descending) feed this is backwards: a newer
        // row (larger _creationTime) should land at the front, not the back. See
        // the executor report.
        expect(insertionIndexFor([row("only", 50)], row("new", 60))).toBe(1);
    });

    // PINNED, NOT ENDORSED: every existing row shares one _creationTime, so
    // `isDescending` never observes a strict order and again defaults to
    // ascending. A same-timestamp insert then finds no existing row "larger", and
    // is appended at the END of the run — even though the docstring's own stated
    // goal ("a fresh newest row lands at the front of a newest-first feed")
    // implies a fresh row sharing the newest timestamp should land at the FRONT
    // if this is in fact a descending feed. See the executor report.
    it("all rows share one _creationTime — a same-timestamp insert is appended after all of them", () => {
        expect.assertions(1);

        const list = [row("a", 100), row("b", 100), row("c", 100)];

        expect(insertionIndexFor(list, row("new", 100))).toBe(3);
    });

    it("a _creationTime tie against one neighbour in an otherwise-ordered ascending list lands after the tied row", () => {
        expect.assertions(1);

        const list = [row("a", 10), row("b", 20), row("c", 30)];

        // Ties are broken by strict `>`/`<`, so an exact match to "b" (20) is not
        // treated as "larger" and the new row lands after it, before "c".
        expect(insertionIndexFor(list, row("new", 20))).toBe(2);
    });

    it("a _creationTime tie against one neighbour in an otherwise-ordered descending list lands after the tied row", () => {
        expect.assertions(1);

        const list = [row("a", 30), row("b", 20), row("c", 10)];

        expect(insertionIndexFor(list, row("new", 20))).toBe(2);
    });
});

describe("insertionIndexFor — rows missing CREATION_FIELD or ID_FIELD", () => {
    it("a new row with no _creationTime is always appended, regardless of list order", () => {
        expect.assertions(2);

        const ascending = [row("a", 10), row("b", 20)];
        const descending = [row("a", 20), row("b", 10)];
        const noTime = { [ID_FIELD]: "new" };

        expect(insertionIndexFor(ascending, noTime)).toBe(2);
        expect(insertionIndexFor(descending, noTime)).toBe(2);
    });

    it("existing rows with no _creationTime are transparent to both direction-detection and placement", () => {
        expect.assertions(1);

        // "note" carries no _creationTime and is skipped when scanning for
        // direction and for a placement index, but its ORIGINAL position in the
        // array is preserved by splice — the new row lands immediately before the
        // first numerically-larger row, "note" included in the count.
        const list = [row("a", 10), { [ID_FIELD]: "note" }, row("c", 30)];

        expect(insertionIndexFor(list, row("new", 20))).toBe(2);
    });

    it("`ID_FIELD` is irrelevant to placement — a row missing _id sorts identically to one that has it", () => {
        expect.assertions(1);

        // insertionIndexFor never reads ID_FIELD (only CREATION_FIELD); confirming
        // this so a future change that starts keying off _id here is a visible
        // behaviour change, not a silent one.
        const list = [{ [CREATION_FIELD]: 10 }, { [CREATION_FIELD]: 30 }];

        expect(insertionIndexFor(list, { [CREATION_FIELD]: 20 })).toBe(1);
    });
});
