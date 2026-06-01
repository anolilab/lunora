/**
 * Aggregate-index runtime — schema-level decls (`aggregateIndex`) plus
 * O(1) `count()` / `aggregate()` / `groupBy()` planning maintained by the
 * trigger seam.
 *
 * The shape is dialect-agnostic so both ORM backends (DO + D1) consume it
 * uniformly: the schema carries `aggregateIndexes` per table, the trigger
 * seam keeps per-`by`-group counter rows in step with row writes, and the
 * reader routes matching `count`/`aggregate`/`groupBy` calls to the counter
 * table — falling back to a scan when the requested `where` keys aren't all
 * covered by an index's `by` set.
 *
 * Coupling seam (load-bearing — read this before changing):
 *
 *   The §3.2 RLS agent will introduce an "RLS-aware ctx" that exposes a
 *   `baseWhere` for the table being queried plus a `restrictsCounts`
 *   predicate. To compose cleanly without a dep cycle the aggregate readers
 *   (and the typed facade emitted by codegen) accept a
 *   {@link RestrictableQueryOptions} arg whose `baseWhere` is AND-merged into
 *   the predicate before the indexed/scan decision, and whose
 *   `restrictsCounts: true` flag flips `count()` into a thrown
 *   `COUNT_RLS_UNSUPPORTED` `CirrusError`.
 *
 *   This is a seam, not an implementation. The aggregates module owns the
 *   types and the merge/throw; the RLS module owns the policy logic.
 *
 * Auto-backfill: a counter table is **lazily** populated on the first read
 * that targets an empty counter, by scanning the source table once. Cheap and
 * correct for dev/test; production backfills can also be triggered up-front
 * via {@link backfillAggregateIndexes} from a one-shot in `runShardMigrations`.
 */

import type { WhereInput } from "./where-clause-compiler.js";

/** Reducer applied by an aggregate index. */
export type AggregateOp = "avg" | "count" | "max" | "min" | "sum";

/**
 * Structural mirror of `@cirrus/server`'s `AggregateIndexDefinition` — kept
 * local so this package doesn't depend on `@cirrus/server` (which would create
 * a cycle).
 */
export interface AggregateIndexDefinitionLike {
    readonly by?: ReadonlyArray<string>;
    readonly field?: string;
    readonly name: string;
    readonly on: string;
    readonly op: AggregateOp;
    readonly where?: Record<string, unknown>;
}

/**
 * Query-options shape shared by every aggregate reader (`count` / `aggregate`
 * / `groupBy` / `rank` once it lands). Defined here so the §3.2 RLS module
 * can import this shape without taking a hard dep on the runtime layer, and
 * so the codegen facade can extend it uniformly.
 *
 * Field semantics:
 *
 * - `where` — the user's filter predicate.
 * - `baseWhere` — a predicate injected by an RLS-aware ctx, AND-merged into
 *   `where` before index planning.
 * - `restrictsCounts` — when `true`, `count()` throws `COUNT_RLS_UNSUPPORTED`
 *   instead of returning a potentially undercounted result. `aggregate` /
 *   `groupBy` are unaffected because they are explicitly scoped to `where`.
 */
export interface RestrictableQueryOptions {
    baseWhere?: WhereInput;
    restrictsCounts?: boolean;
    where?: WhereInput;
}

/** Args for {@link DatabaseWriterLike.aggregate}. */
export interface AggregateOptions extends RestrictableQueryOptions {
    /** The column the reducer applies to (ignored for `count`). */
    field?: string;
    op: AggregateOp;
}

/** Args for {@link DatabaseWriterLike.groupBy}. */
export interface GroupByOptions extends RestrictableQueryOptions {
    /** Reducer applied per group; defaults to `count` to mirror SQL `GROUP BY`. */
    agg?: { field?: string; op: AggregateOp };
    by: ReadonlyArray<string>;
}

/** Result of `aggregate` — the scalar reduction, or `null` when no rows matched. */
export type AggregateResult = null | number;

/** Result of `groupBy` — one entry per distinct group tuple. */
export interface GroupByEntry {
    key: Record<string, unknown>;
    value: AggregateResult;
}

/**
 * Thrown when `count` runs in an RLS-restricted ctx. The structural shape
 * (`name: "CirrusError"`, `code`, `status`) lets the runtime's error mapper
 * route it without an `instanceof` check, so `@cirrus/do` stays free of a
 * runtime dependency on `@cirrus/server`. Status mirrors the
 * `COUNT_RLS_UNSUPPORTED` entry in the {@link CirrusErrorCode} taxonomy (422):
 * the operation is invalid in this context, not malformed.
 */
export class CountRlsUnsupportedError extends Error {
    public readonly code: string = "COUNT_RLS_UNSUPPORTED";

    public override readonly name = "CirrusError";

    public readonly status: number = 422;

    constructor(table?: string) {
        super(
            table === undefined
                ? "count() is not supported in an RLS-restricted context"
                : `count() is not supported on table "${table}" inside an RLS-restricted context`,
        );
    }
}

/**
 * AND-merge two `where` trees. Returns `undefined` when both inputs are absent
 * so the caller doesn't pay the cost of a no-op predicate.
 */
export const mergeWhere = (left: undefined | WhereInput, right: undefined | WhereInput): undefined | WhereInput => {
    if (!left) {
        return right;
    }

    if (!right) {
        return left;
    }

    return { AND: [left, right] };
};

/**
 * Whether the requested `where` is answerable from `index`. The reader can
 * route to the counter only when every `where` key participates in the index's
 * `by` set, every condition is a literal/`eq` comparison (range/in/etc are
 * scan-only), and any static `where` baked into the index is satisfied
 * literally by the request (or absent on either side).
 *
 * Returns the resolved `by`-key values when a hit is possible, else `undefined`.
 */
export const planAggregateLookup = (
    index: AggregateIndexDefinitionLike,
    requestedWhere: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
    const by = index.by ?? [];
    const requested = requestedWhere ?? {};

    // The request must not carry boolean combinators — the indexed path only
    // handles conjunctions of equality on the by-keys.
    for (const key of Object.keys(requested)) {
        if (key === "AND" || key === "OR" || key === "NOT") {
            return undefined;
        }
    }

    // Every key in the request must participate in `by`.
    for (const key of Object.keys(requested)) {
        if (!by.includes(key)) {
            return undefined;
        }
    }

    const resolved: Record<string, unknown> = {};

    for (const key of by) {
        if (!(key in requested)) {
            // Missing by-key — the index can't answer because the counter is
            // partitioned by it.
            return undefined;
        }

        const value = (requested as Record<string, unknown>)[key];

        // Only literal/`eq` comparators are routable.
        if (value !== null && typeof value === "object" && !Array.isArray(value)) {
            const operatorKeys = Object.keys(value as Record<string, unknown>);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                resolved[key] = (value as { eq: unknown }).eq;

                continue;
            }

            return undefined;
        }

        resolved[key] = value;
    }

    // Static `where` on the index must agree with the request when present.
    if (index.where) {
        for (const [key, value] of Object.entries(index.where)) {
            if (key in resolved) {
                if (resolved[key] !== value) {
                    return undefined;
                }
            } else if (key in requested) {
                if ((requested as Record<string, unknown>)[key] !== value) {
                    return undefined;
                }
            } else {
                // The request didn't mention this static key — the index still
                // covers it implicitly because every counter row was inserted
                // under `where`. Carry the value forward so the counter lookup
                // is exact.
                resolved[key] = value;
            }
        }
    }

    return resolved;
};

/**
 * Derive the constrained key fragment for a groupBy indexed path. Returns
 * `undefined` when the request is non-routable (boolean combinators,
 * extra-field where, non-`eq` operators, static-where conflict). Unlike
 * {@link planAggregateLookup}, an unfiltered request is OK — the result is
 * an empty partial that the caller turns into a "walk the whole companion"
 * scan.
 */
const collectPartialKey = (
    index: AggregateIndexDefinitionLike,
    requestedWhere: Record<string, unknown> | undefined,
    byFields: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
    const requested = requestedWhere ?? {};
    const partial: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(requested)) {
        if (key === "AND" || key === "OR" || key === "NOT") {
            return undefined;
        }

        if (!byFields.has(key)) {
            return undefined;
        }

        if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
            const operatorKeys = Object.keys(raw as Record<string, unknown>);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                partial[key] = (raw as { eq: unknown }).eq;

                continue;
            }

            return undefined;
        }

        partial[key] = raw;
    }

    // Static where: must agree with request when both mention a key; extra
    // static keys are carried into `partial` as implicit constraints.
    if (index.where) {
        for (const [key, value] of Object.entries(index.where)) {
            if (key in partial) {
                if (partial[key] !== value) {
                    return undefined;
                }
            } else {
                partial[key] = value;
            }
        }
    }

    return partial;
};

/** Internal: shared by `selectIndexForCount` and `selectIndexForAggregate`. */
const selectIndexForReducer = (
    indexes: ReadonlyArray<AggregateIndexDefinitionLike>,
    op: AggregateOp,
    field: string | undefined,
    requestedWhere: Record<string, unknown> | undefined,
): undefined | { index: AggregateIndexDefinitionLike; key: Record<string, unknown> } => {
    let best: undefined | { index: AggregateIndexDefinitionLike; key: Record<string, unknown> };

    for (const index of indexes) {
        if (index.op !== op) {
            continue;
        }

        if (op !== "count" && index.field !== field) {
            continue;
        }

        const key = planAggregateLookup(index, requestedWhere);

        if (!key) {
            continue;
        }

        if (!best || (index.by?.length ?? 0) > (best.index.by?.length ?? 0)) {
            best = { index, key };
        }
    }

    return best;
};

/**
 * Select the best matching aggregate index for a `count` request — the one
 * whose `where` baseline matches the request (subset semantics: the index's
 * baked-in `where` is implied by the request) and whose `by` set covers every
 * filtered key. Prefers narrower (more-specific) `by` sets so equality on
 * `(userId, status)` beats equality on `(userId)` for a request that filters
 * both.
 */
export const selectIndexForCount = (
    indexes: ReadonlyArray<AggregateIndexDefinitionLike>,
    requestedWhere: Record<string, unknown> | undefined,
): undefined | { index: AggregateIndexDefinitionLike; key: Record<string, unknown> } => selectIndexForReducer(indexes, "count", undefined, requestedWhere);

/**
 * Generalised version of {@link selectIndexForCount} for non-`count` reducers.
 * The match additionally requires the index's `op` AND `field` agree with the
 * request — `aggregate({ op: "sum", field: "seq" })` needs an
 * `aggregateIndex({ op: "sum", field: "seq" })`. Same `by`-prefer-wider tiebreak.
 */
export const selectIndexForAggregate = (
    indexes: ReadonlyArray<AggregateIndexDefinitionLike>,
    op: AggregateOp,
    field: string,
    requestedWhere: Record<string, unknown> | undefined,
): undefined | { index: AggregateIndexDefinitionLike; key: Record<string, unknown> } => selectIndexForReducer(indexes, op, field, requestedWhere);

/**
 * Match an aggregate index whose `by` shape *exactly* matches the caller's
 * `groupBy.by`. The companion table is keyed by the by-tuple, so a scan of
 * the whole companion table answers `groupBy()` in one pass — no SQL
 * `GROUP BY` needed. The match additionally requires:
 *
 *  - `op` (and `field`, when not `count`) agree with the request,
 *  - the requested `where` keys are a subset of `by` (we filter the
 *    companion by `__key__`); arbitrary predicates fall back to scan,
 *  - the index's static `where` (if any) is satisfied by the request.
 *
 * Returns the index and the partial key the request constrains (may be
 * empty for an unfiltered groupBy — meaning "read every counter row").
 */
export const selectIndexForGroupBy = (
    indexes: ReadonlyArray<AggregateIndexDefinitionLike>,
    op: AggregateOp,
    field: string | undefined,
    by: ReadonlyArray<string>,
    requestedWhere: Record<string, unknown> | undefined,
): undefined | { index: AggregateIndexDefinitionLike; partial: Record<string, unknown> } => {
    const requestedFields = new Set(by);

    for (const index of indexes) {
        if (index.op !== op) {
            continue;
        }

        if (op !== "count" && index.field !== field) {
            continue;
        }

        const indexBy = index.by ?? [];

        if (indexBy.length !== requestedFields.size) {
            continue;
        }

        if (!indexBy.every((key) => requestedFields.has(key))) {
            continue;
        }

        const partial = collectPartialKey(index, requestedWhere, requestedFields);

        if (partial === undefined) {
            continue;
        }

        return { index, partial };
    }

    return undefined;
};
