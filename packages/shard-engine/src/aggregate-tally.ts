/**
 * Shared aggregate-companion primitives for the DO and D1 ctx-db dialects.
 *
 * Both backends maintain a per-`aggregateIndex` counter table (`__agg_` infix)
 * that answers `count`/`sum`/`avg`/`min`/`max` without scanning. The companion
 * naming, canonical `by`-tuple key encoding, numeric coercion, backfill tally
 * fold, and read-time projection are dialect-agnostic, so they live here and are
 * imported by both `ctx-db.ts` (`@lunora/do`) and `d1-ctx-db.ts` (`@lunora/d1`) —
 * guaranteeing the two engines maintain and read companions byte-for-byte
 * identically.
 */

import { encodeWire } from "../../../shared/wire-codec";
import type { AggregateIndexDefinitionLike } from "./schema-types";

/** Code-point-stable string comparator (no locale dependence) for canonical key ordering. Shared with the rank twin (`rank.ts`). */
export const compareStrings = (a: string, b: string): number => {
    if (a < b) {
        return -1;
    }

    return a > b ? 1 : 0;
};

/**
 * Name of the counter table backing an `aggregateIndex` decl. Kept distinct
 * from any user table (`__agg_` infix is reserved) so `runShardMigrations` can
 * create it alongside the document table without collision. The schema is a
 * `__key__` column (the canonical JSON-encoded `by`-tuple), a floating
 * `__value__` column (op-aware: the count, running sum, or stored extreme —
 * `NULL` for an empty min/max group), and a `__count__` integer (rows in the
 * group, used as `avg`'s divisor and for empty-group / extreme-recompute
 * detection). We keep `__value__` as REAL so the one physical shape carries
 * count/sum/min/max/avg.
 */
export const aggregateTableName = (table: string, indexName: string): string => `${table}__agg_${indexName}`;

/**
 * Coerce a doc field to the numeric value a reducer contributes, or `undefined`
 * when the value isn't numeric. Mirrors how the SQL scan path treats `SUM`/
 * `AVG`/`MIN`/`MAX` over `json_extract` — a `null`/non-numeric field is skipped
 * (it neither shifts the running value nor counts toward `avg`'s divisor), so
 * the maintained companion matches the scan answer for the typical
 * always-numeric column and degrades the same way for a stray non-number.
 *
 * A `v.bigint()` field contributes too, coerced through `Number` — the same
 * projection `encodeDocJson` stores and the SQL scan path therefore reads, so
 * the maintained companion and the scan agree. Without it a `sum` over a money
 * column silently reported 0.
 * @returns the numeric value when finite, or `undefined` when not a finite number
 */
export const coerceAggregateNumber = (value: unknown): number | undefined => {
    if (typeof value === "bigint") {
        const asNumber = Number(value);

        return Number.isFinite(asNumber) ? asNumber : undefined;
    }

    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }

    return undefined;
};

/** A backfill accumulator for one companion group: the op-aware value + row count. */
export interface AggregateTally {
    count: number;
    value: null | number;
}

/**
 * Fold one source row into the per-group {@link AggregateTally} during a
 * backfill scan, op-aware so the seeded `__value__`/`__count__` match what the
 * incremental `applyAggregateDelta` maintains:
 *
 * - **count**: value = count = row tally.
 * - **sum/avg**: value = running sum of numeric `field`s, count = numeric-row tally.
 * - **min/max**: value = extreme of numeric `field`s (`null` until one appears), count = row tally (so an all-non-numeric group still reads as non-empty).
 *
 * The caller pre-filters rows through the index's static `where`.
 */
export const foldAggregateTally = (
    tallies: Map<string, AggregateTally>,
    encoded: string,
    index: AggregateIndexDefinitionLike,
    record: Record<string, unknown>,
): void => {
    // eslint-disable-next-line unicorn/no-null -- empty group's running value seeds as null; the count op overwrites it below
    const tally = tallies.get(encoded) ?? { count: 0, value: null };

    if (index.op === "count") {
        tally.count += 1;
        tally.value = tally.count;
        tallies.set(encoded, tally);

        return;
    }

    const numeric = coerceAggregateNumber(record[index.field ?? ""]);

    if (index.op === "sum" || index.op === "avg") {
        if (numeric !== undefined) {
            tally.value = (tally.value ?? 0) + numeric;
            tally.count += 1;
        }

        tallies.set(encoded, tally);

        return;
    }

    // min/max: every row counts toward the group; only numeric ones move the extreme.
    tally.count += 1;

    if (numeric !== undefined) {
        if (tally.value === null) {
            tally.value = numeric;
        } else {
            tally.value = index.op === "min" ? Math.min(tally.value, numeric) : Math.max(tally.value, numeric);
        }
    }

    tallies.set(encoded, tally);
};

/**
 * Project a maintained companion row onto the scalar an `aggregate()` reader
 * returns for `op`. Mirrors the SQL scan's empty-group contract: an absent /
 * empty group is `null`; `avg` divides the running sum by the row count (`null`
 * when the divisor is 0); `sum`/`min`/`max` return `__value__` verbatim
 * (`min`/`max` already store `NULL` for an empty group).
 * @returns the aggregate scalar value: `null` for an empty group, or the computed result
 */
export const readAggregateValue = (op: string, row: { count: number; value: null | number } | undefined): null | number => {
    if (op === "count") {
        // count keeps its pre-reducer-aware contract: `__value__` is the count,
        // an absent / emptied group reads as 0 (not null).
        return row?.value ?? 0;
    }

    if (!row || row.count === 0) {
        // eslint-disable-next-line unicorn/no-null -- AggregateResult is `null | number`: null is the documented "no rows matched" result
        return null;
    }

    if (op === "avg") {
        // eslint-disable-next-line unicorn/no-null -- guarded above, but keep the empty-divisor branch explicit for the type narrowing
        return row.value === null ? null : row.value / row.count;
    }

    return row.value;
};

/**
 * Encode a `by`-key tuple into a stable string. We use canonical-key JSON so
 * the same `{ a: 1, b: 2 }` lookup never misses for an insert that stored it
 * as `{ b: 2, a: 1 }`. Empty `by` (whole-table aggregate) keys on the empty
 * string.
 *
 * The tuple goes through `encodeWire` first so a `v.bigint()` / `v.bytes()`
 * `by` field keys stably instead of throwing out of `JSON.stringify`. The wire
 * codec is the identity on a tree with no such leaf, so every key already stored
 * in a `__key__` column is byte-for-byte unchanged.
 */
export const encodeAggregateKey = (by: ReadonlyArray<string>, source: Record<string, unknown>): string => {
    if (by.length === 0) {
        return "";
    }

    const ordered: Record<string, unknown> = {};

    for (const field of by.toSorted(compareStrings)) {
        // eslint-disable-next-line unicorn/no-null -- canonical JSON aggregate key: a missing field must serialize as null (stable across runs), not be dropped by JSON.stringify
        ordered[field] = source[field] ?? null;
    }

    return JSON.stringify(encodeWire(ordered));
};
