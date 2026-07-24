import { bench, describe } from "vitest";

import { applyDiff, applyDiffs, applyDiffToSnapshot } from "../src/apply-diff";
import type { RowChange, TableDiff } from "../src/table-diff";

/*
 * `applyDiff` is the client-side replication hot path: every poke from the
 * server lands here, and catch-up replay pushes the whole backlog through
 * `applyDiffs` in one go. Three costs dominate and each gets its own bench:
 *
 *  1. Map copying. `applyDiff` shallow-copies the row map so the caller's
 *     reference stays intact. `applyDiffs` used to re-copy per diff (N+1 copies
 *     for N diffs) despite documenting the opposite — the `applyDiffs — N diffs`
 *     benches below are what make that regression visible.
 *  2. Insert-id derivation. Inserts whose `data` carries no `id` hash the diff
 *     identity + canonical `data`, so the id survives replay. That hash runs
 *     per id-less insert, so it is benched separately from the cheap
 *     id-carrying insert path.
 *  3. Canonicalization. The hash input is a canonical (recursively sorted-key)
 *     encoding of `data`, so nesting depth and key count matter — hence the
 *     shallow/nested split.
 *
 * Fixtures are built once at module scope: the bench measures apply cost, not
 * fixture construction.
 */

// ---- Fixtures ------------------------------------------------------------

const ROW_COUNT = 500;

const seedRows = (count: number): Map<string, Record<string, unknown>> => {
    const rows = new Map<string, Record<string, unknown>>();

    for (let index = 0; index < count; index += 1) {
        rows.set(`row-${String(index)}`, {
            active: index % 3 === 0,
            id: `row-${String(index)}`,
            name: `user-${String(index)}`,
            score: index * 7,
        });
    }

    return rows;
};

const baseRows = seedRows(ROW_COUNT);

const makeDiff = (changes: RowChange[], id: string): TableDiff => {
    return { changes, id, table: "users", timestamp: 1_700_000_000_000 };
};

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

/** Id-less inserts with a nested payload — canonicalization recurses. */
const nestedInsertDiff = makeDiff(
    Array.from({ length: 50 }, (_, index) => {
        return {
            data: {
                author: { email: `u${String(index)}@example.com`, id: `u-${String(index)}`, name: `user ${String(index)}` },
                body: `message body number ${String(index)} with some prose in it`,
                meta: { attachments: [{ size: 1024, url: "https://example.com/a" }], edited: false, reactions: { "+1": index, heart: 2 } },
                tags: ["alpha", "beta", "gamma"],
            },
            type: "insert",
        } satisfies RowChange;
    }),
    "diff-nested",
);

/** A backlog of small diffs, as catch-up replay after a reconnect delivers. */
const backlog = Array.from({ length: 64 }, (_, index) =>
    makeDiff(
        [
            { data: { id: `bl-${String(index)}`, name: `bl-${String(index)}`, score: index }, type: "insert" },
            { data: { score: index }, id: `row-${String(index % ROW_COUNT)}`, type: "update" },
        ],
        `diff-backlog-${String(index)}`,
    ),
);

const snapshot = new Map<string, ReadonlyMap<string, Record<string, unknown>>>([
    ["comments", seedRows(100)],
    ["posts", seedRows(100)],
    ["users", baseRows],
]);

// ---- Benches -------------------------------------------------------------

describe("applyDiff — single diff over a 500-row map", () => {
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

describe("applyDiffs — 64-diff catch-up backlog over a 500-row map", () => {
    bench("applyDiffs(backlog)", () => {
        applyDiffs(baseRows, backlog);
    });
});

describe("applyDiffToSnapshot — 3-table snapshot", () => {
    bench("applyDiffToSnapshot(mixed)", () => {
        applyDiffToSnapshot(snapshot, mixedDiff);
    });
});
