import type { RowChange, TableDiff } from "../src/table-diff";

/**
 * Shared bench fixtures (visulima `__bench__/shared.ts` convention).
 *
 * `apply-diff.bench.ts` (absolute costs) and `apply-diff-hotpath.bench.ts`
 * (old-vs-new contrast) both drive `applyDiff`/`applyDiffs` over the same
 * scenarios. Defining the fixtures once is not just deduplication: the two
 * files previously carried their own copies that had silently DIVERGED (a
 * different row shape, and a hard-coded row count against a named constant), so
 * two similarly-titled `applyDiffs — 64-diff backlog` benches were measuring
 * the same call over different inputs. On a CodSpeed dashboard that reads as a
 * meaningful comparison and is not one.
 *
 * `*.shared.ts` does not match the `__bench__/**\/*.bench.{ts,tsx}` include
 * glob, so this file costs nothing at run time.
 */

/** Rows in the base map every bench applies diffs against. */
export const ROW_COUNT = 500;

/** Build a keyed row map of `count` rows. */
export const seedRows = (count: number): Map<string, Record<string, unknown>> => {
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

/** The base map every bench applies diffs against. */
export const baseRows = seedRows(ROW_COUNT);

/** A diff with a fixed timestamp, so nothing in a bench body reads the clock. */
export const makeDiff = (changes: RowChange[], id: string): TableDiff => {
    return { changes, id, table: "users", timestamp: 1_700_000_000_000 };
};

/** A nested row payload — canonicalization has to recurse through it. */
export const nestedPayload = (index: number): Record<string, unknown> => {
    return {
        author: { email: `u${String(index)}@example.com`, id: `u-${String(index)}`, name: `user ${String(index)}` },
        body: `message body number ${String(index)} with some prose in it`,
        meta: { attachments: [{ size: 1024, url: "https://example.com/a" }], edited: false, reactions: { "+1": index, heart: 2 } },
        tags: ["alpha", "beta", "gamma"],
    };
};

/** 50 id-less inserts with a nested payload — every one derives its id by hashing. */
export const nestedInsertDiff = makeDiff(
    Array.from({ length: 50 }, (_, index) => {
        return { data: nestedPayload(index), type: "insert" } satisfies RowChange;
    }),
    "diff-nested",
);

/** A backlog of small diffs, as catch-up replay after a reconnect delivers. */
export const backlog = Array.from({ length: 64 }, (_, index) =>
    makeDiff(
        [
            { data: { id: `bl-${String(index)}`, name: `bl-${String(index)}`, score: index }, type: "insert" },
            { data: { score: index }, id: `row-${String(index % ROW_COUNT)}`, type: "update" },
        ],
        `diff-backlog-${String(index)}`,
    ),
);
