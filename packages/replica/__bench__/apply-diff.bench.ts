import { bench, describe } from "vitest";

import { applyDiff, applyDiffs, applyDiffToSnapshot } from "../src/apply-diff";
import type { RowChange } from "../src/table-diff";
import { backlog, baseRows, makeDiff, nestedInsertDiff, ROW_COUNT, seedRows } from "./apply-diff.shared";

/*
 * `applyDiff` is the client-side replication hot path: every poke from the
 * server lands here, and catch-up replay pushes the whole backlog through
 * `applyDiffs` in one go. Three costs dominate and each gets its own bench:
 *
 *  1. Map copying. `applyDiff` shallow-copies the row map so the caller's
 *     reference stays intact. `applyDiffs` used to re-copy per diff (N+1 copies
 *     for N diffs) despite documenting the opposite.
 *  2. Insert-id derivation. Inserts whose `data` carries no `id` hash the diff
 *     identity + canonical `data`, so the id survives replay. That hash runs
 *     per id-less insert, so it is benched separately from the cheap
 *     id-carrying insert path.
 *  3. Canonicalization. The hash input is a canonical (sorted-key) encoding of
 *     `data`, so nesting depth and key count matter — hence the flat/nested split.
 *
 * This file measures ABSOLUTE cost; `apply-diff-hotpath.bench.ts` carries the
 * old-vs-new contrast. Both draw fixtures from `apply-diff.shared.ts` so the
 * two files cannot drift into measuring different inputs under the same title.
 */

// ---- Fixtures ------------------------------------------------------------

/** A realistic poke: a few inserts, a few updates, a delete — all id-carrying. */
const mixedDiff = makeDiff(
    [
        { data: { id: "row-1000", name: "new-a", score: 1 }, type: "insert" },
        { data: { id: "row-1001", name: "new-b", score: 2 }, type: "insert" },
        { data: { score: 99 }, id: "row-10", type: "update" },
        { data: { score: 98 }, id: "row-20", type: "update" },
        { data: { name: "renamed" }, id: "row-30", type: "update" },
        { id: "row-40", type: "delete" },
    ],
    "diff-mixed",
);

/** Inserts that carry their own `id` — no hashing, just a map set. */
const keyedInsertDiff = makeDiff(
    Array.from({ length: 50 }, (_, index) => {
        return { data: { id: `keyed-${String(index)}`, name: `n-${String(index)}`, score: index }, type: "insert" } satisfies RowChange;
    }),
    "diff-keyed",
);

/** Id-less inserts with a flat payload — every one derives its id by hashing. */
const derivedInsertDiff = makeDiff(
    Array.from({ length: 50 }, (_, index) => {
        return { data: { name: `n-${String(index)}`, score: index, tag: "flat" }, type: "insert" } satisfies RowChange;
    }),
    "diff-derived",
);

const snapshot = new Map<string, ReadonlyMap<string, Record<string, unknown>>>([
    ["comments", seedRows(100)],
    ["posts", seedRows(100)],
    ["users", baseRows],
]);

// ---- Benches -------------------------------------------------------------

describe(`applyDiff — single diff over a ${String(ROW_COUNT)}-row map`, () => {
    bench("mixed insert/update/delete (id-carrying)", () => {
        applyDiff(baseRows, mixedDiff);
    });

    bench("50 id-carrying inserts", () => {
        applyDiff(baseRows, keyedInsertDiff);
    });

    bench("50 id-less inserts — flat payload (derives ids)", () => {
        applyDiff(baseRows, derivedInsertDiff);
    });

    bench("50 id-less inserts — nested payload (derives ids)", () => {
        applyDiff(baseRows, nestedInsertDiff);
    });
});

describe(`applyDiffs — 64-diff catch-up backlog over a ${String(ROW_COUNT)}-row map`, () => {
    bench("applyDiffs(backlog)", () => {
        applyDiffs(baseRows, backlog);
    });
});

describe("applyDiffToSnapshot — 3-table snapshot", () => {
    bench("applyDiffToSnapshot(mixed)", () => {
        applyDiffToSnapshot(snapshot, mixedDiff);
    });
});
