/**
 * The row-list shape a live query result can carry, and the rules for merging a
 * row delta into it — shared (bundler-inlined, like {@link file://./stable-key.ts})
 * by the client SDK (`@lunora/client`) and the reactive engine
 * (`@lunora/shard-engine`).
 *
 * ## Why this is shared rather than mirrored
 *
 * `@lunora/client` mirrors the server's `MutationDelta` *type* rather than
 * importing it, and that is fine: a type drifts loudly, at the next `tsc`.
 * These are different. They are a **runtime agreement behind a negotiated
 * capability**, and drift is silent data corruption:
 *
 * - if the two sides disagree on what counts as a paginated result, the server
 *   sends a row delta the client cannot merge, `applyDelta` returns `undefined`,
 *   and the caller replaces the whole query value with the raw delta object;
 * - if they disagree on where an inserted row lands, the client's list order
 *   silently diverges from the server's and STAYS diverged, because the server
 *   advances its diff baseline to the value it believes the client now holds.
 *
 * Guarding against that with two independently-maintained copies of the same
 * predicate would defeat the point of the capability gate, so both sides import
 * these instead. Zero dependencies (relative/built-in imports only), per the
 * `shared/` contract.
 */

import { isPlainObject } from "./wire-codec";

/** Identity field every Lunora document row carries. */
const ID_FIELD = "_id";

/** Creation-time field used as the default sort key for inserts. */
const CREATION_FIELD = "_creationTime";

/** The row-array field a `.paginate()` result carries its page in. */
const PAGE_FIELD = "page";

/**
 * The `connect`-frame capability token a client sends to say it can merge a row
 * delta into the `page` of a `{ page, isDone, continueCursor }` result.
 *
 * Opt-in, and it has to be: an unmergeable delta is not ignored by a client that
 * predates this — the merge bails and the caller replaces the whole query value
 * with the raw delta object. A client that never announces this keeps receiving
 * full snapshots, which is what every client did before, and what the non-JS
 * SDKs still do (they send `connect` with no `caps` at all).
 */
const PAGE_DELTA_CAPABILITY = "pageDelta";

/**
 * The row list inside a live query result, or `undefined` when it holds none.
 *
 * Two accepted shapes:
 *
 * - the result IS the array — `ctx.db.query(...).collect()`;
 * - the result is `{ page: [...], … }` — what `.paginate()` yields, and
 *   therefore what every `usePaginatedQuery` page holds.
 * @returns the row list, or `undefined` when the value carries none
 */
const rowListOf = (value: unknown): undefined | unknown[] => {
    if (Array.isArray(value)) {
        return value as unknown[];
    }

    // `isPlainObject`, not a bare `typeof === "object"`: the wrapper is re-spread
    // to swap its page, which would quietly flatten a class instance or any
    // other exotic object into a plain one. Reusing the CODEC's definition is
    // what makes that safe rather than merely defensive — it is exactly the set
    // of objects that survives the wire, so anything it rejects could not have
    // reached a client as this shape in the first place.
    if (isPlainObject(value) && Array.isArray(value[PAGE_FIELD])) {
        return value[PAGE_FIELD] as unknown[];
    }

    return undefined;
};

/**
 * Detect the ordering direction of a list from its rows' `_creationTime` run.
 * `true` when the list is sorted descending (newest-first — the common chat/feed
 * shape), `false` for ascending or when the direction is indeterminate (0/1
 * numeric rows, or an all-equal run). Reads the FIRST strictly-ordered adjacent
 * numeric pair and stops there — so an equal-timestamp run at the head is
 * skipped rather than answered, but one out-of-order row AT THE HEAD does decide
 * the whole list. That is deliberate cheapness, not a majority vote: the server
 * re-runs {@link insertionIndexFor} against the page its query actually returned
 * and sends a snapshot when the two disagree, so a wrong guess costs a snapshot,
 * never a misplaced row.
 * @returns `true` when the list reads newest-first
 */
const isDescending = (list: ReadonlyArray<Record<string, unknown>>): boolean => {
    let previous: number | undefined;

    for (const existingRow of list) {
        const existing = existingRow[CREATION_FIELD];

        if (typeof existing !== "number") {
            continue;
        }

        if (previous !== undefined) {
            if (existing < previous) {
                return true;
            }

            if (existing > previous) {
                return false;
            }
        }

        previous = existing;
    }

    return false;
};

/**
 * Where a merging client will splice a newly-inserted row into an ordered list.
 *
 * An `insert` delta carries no position, so this heuristic is the only thing
 * deciding it: with a numeric `_creationTime` on both the new row and its
 * neighbours we honour the list's OWN direction — ascending inserts before the
 * first larger neighbour, descending before the first smaller one, so a fresh
 * newest row lands at the front of a feed {@link isDescending} can READ as
 * newest-first. A list too short to have a direction (one row, or an all-equal
 * run) reads as ascending, and the new row is appended. With no usable ordering
 * we append too, keeping insertion order and never reordering existing rows.
 *
 * The SERVER calls this too, to check the position it would produce matches the
 * one its query actually returned — a page ordered by a `.withIndex()` field
 * rather than by `_creationTime` can disagree, and the server then sends a full
 * snapshot instead of a delta the client would misplace. That check is only
 * sound while both sides run this exact function, which is why it lives here.
 * @returns the index the row should be spliced at
 */
const insertionIndexFor = (list: ReadonlyArray<Record<string, unknown>>, row: Record<string, unknown>): number => {
    const creation = row[CREATION_FIELD];

    if (typeof creation !== "number") {
        return list.length;
    }

    const descending = isDescending(list);

    for (const [index, existingRow] of list.entries()) {
        const existing = existingRow[CREATION_FIELD];

        if (typeof existing === "number" && (descending ? existing < creation : existing > creation)) {
            return index;
        }
    }

    return list.length;
};

export { CREATION_FIELD, ID_FIELD, insertionIndexFor, PAGE_DELTA_CAPABILITY, PAGE_FIELD, rowListOf };
