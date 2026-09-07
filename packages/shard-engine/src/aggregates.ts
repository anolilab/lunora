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
 * covered by an index's `by` set, or when the index's own static `where` is not
 * implied by the request (see `staticWhereIsImplied`).
 *
 * Coupling seam (load-bearing — read this before changing):
 *
 * The §3.2 RLS agent will introduce an "RLS-aware ctx" that exposes a
 * `baseWhere` for the table being queried plus a `restrictsCounts`
 * predicate. To compose cleanly without a dep cycle the aggregate readers
 * (and the typed facade emitted by codegen) accept a `RestrictableQueryOptions`
 * arg whose `baseWhere` is AND-merged into the predicate before the
 * indexed/scan decision, and whose `restrictsCounts: true` flag flips
 * `count()` into a thrown `COUNT_RLS_UNSUPPORTED` `LunoraError`.
 *
 * This is a seam, not an implementation. The aggregates module owns the
 * types and the merge/throw; the RLS module owns the policy logic.
 *
 * Auto-backfill: a counter table is **lazily** populated on the first read
 * that targets an empty counter, by scanning the source table once. Cheap and
 * correct for dev/test; production backfills can also be triggered up-front
 * via `backfillAggregateIndexes` from a one-shot in `runShardMigrations`.
 */

import { LunoraError } from "@lunora/errors";

import type { AggregateIndexDefinitionLike, AggregateOp } from "./schema-types";
import type { WhereInput } from "./where-types";

/**
 * Thrown when `count` runs in an RLS-restricted ctx. A `LunoraError` subclass
 * (`code: "COUNT_RLS_UNSUPPORTED"`, `status: 422`) recognised structurally by the
 * runtime's error mapper (via `isLunoraError`), so `@lunora/do` needs no runtime
 * dependency on `@lunora/server`. 422 = the operation is invalid in this context,
 * not malformed.
 */
class CountRlsUnsupportedError extends LunoraError {
    public constructor(table?: string) {
        super(
            "COUNT_RLS_UNSUPPORTED",
            table === undefined
                ? "count() is not supported in an RLS-restricted context"
                : `count() is not supported on table "${table}" inside an RLS-restricted context`,
        );
    }
}

/**
 * AND-merge two `where` trees. Returns `undefined` when both inputs are absent
 * so the caller doesn't pay the cost of a no-op predicate.
 * @returns the merged where clause, or `undefined` when both sides are absent
 */
const mergeWhere = (left: undefined | WhereInput, right: undefined | WhereInput): undefined | WhereInput => {
    if (!left) {
        return right;
    }

    if (!right) {
        return left;
    }

    return { AND: [left, right] };
};

const BOOLEAN_COMBINATORS = new Set(["AND", "NOT", "OR"]);

/** Sentinel: a `where` value that the indexed path can't route (range/in/non-`eq`). */
const NOT_EQ = Symbol("not-eq");

/**
 * Reduce a single `where` value to its literal equality target, or the
 * `NOT_EQ` sentinel when it carries a non-`eq` operator (range/`in`/etc) that
 * the indexed path can't satisfy. A bare literal is its own equality target.
 */
const resolveEqValue = (value: unknown): unknown => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const operatorKeys = Object.keys(value);

        if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
            return (value as { eq: unknown }).eq;
        }

        return NOT_EQ;
    }

    return value;
};

/**
 * Reduce a request's `where` keys to their literal equality values, keeping
 * only keys that pass `accept`. Returns `undefined` when the request carries a
 * boolean combinator, an unaccepted key, or a non-`eq` operator (all of which
 * are scan-only). Each accepted key maps to its resolved literal.
 * @returns the resolved equality key map, or `undefined` when the request is not routeable via an index
 */
const parseRequestedEqKeys = (requested: Record<string, unknown>, accept: (key: string) => boolean): Record<string, unknown> | undefined => {
    const resolved: Record<string, unknown> = {};

    for (const [key, raw] of Object.entries(requested)) {
        if (BOOLEAN_COMBINATORS.has(key) || !accept(key)) {
            return undefined;
        }

        const value = resolveEqValue(raw);

        if (value === NOT_EQ) {
            return undefined;
        }

        resolved[key] = value;
    }

    return resolved;
};

/**
 * Whether an index's static `where` is IMPLIED by the request — every static key
 * pinned by the request to the same literal.
 *
 * Implication, not reconciliation. A filtered counter tallies only the rows its
 * static `where` admits, so routing a request that does NOT carry that filter
 * answers a strictly narrower question than the one asked. Carrying the static
 * key forward into the lookup key (which is what this used to do) makes the
 * lookup "exact" against the counter and wrong against the caller:
 * `count({ status: "open" })` against an `aggregateIndex({ by: ["status"],
 * where: { deletedAt: null } })` returned the LIVE open count for a request that
 * never asked to exclude deleted rows. `{ status: "open" }` does not imply
 * `deletedAt IS NULL`.
 *
 * Absent-vs-null follows `matchesStaticWhere`: a request pinning a key to
 * `null` implies a static `null`, because that is the value the counter was
 * tallied under.
 * @returns true when every static-`where` key is pinned by the request to the same value
 */
const staticWhereIsImplied = (staticWhere: Record<string, unknown> | undefined, resolved: Record<string, unknown>): boolean => {
    if (!staticWhere) {
        return true;
    }

    for (const [key, expected] of Object.entries(staticWhere)) {
        if (!(key in resolved)) {
            return false;
        }

        const target = resolveEqValue(expected);

        // `NOT_EQ` (a static `where` carrying a range/`in` operator) is a symbol,
        // so it can never equal a resolved literal — a non-`eq` static filter is
        // never implied, which is the conservative answer.
        // eslint-disable-next-line unicorn/no-null -- absent and null are the same pin here, matching `matchesStaticWhere`
        if ((resolved[key] ?? null) !== (target ?? null)) {
            return false;
        }
    }

    return true;
};

/**
 * Whether the requested `where` is answerable from `index`. The reader can
 * route to the counter only when every `where` key participates in the index's
 * `by` set or its static `where`, every condition is a literal/`eq` comparison
 * (range/in/etc are scan-only), every `by` key is pinned, and the index's static
 * `where` is implied by the request (see `staticWhereIsImplied`).
 *
 * Returns the resolved key values when a hit is possible, else `undefined`.
 * @returns the resolved by-key values when a counter hit is possible, or `undefined` when the request must fall back to a scan
 */
const planAggregateLookup = (index: AggregateIndexDefinitionLike, requestedWhere: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    const by = index.by ?? [];
    const staticWhere = index.where;
    const requested = requestedWhere ?? {};

    // The indexed path only handles conjunctions of equality, on the by-keys or
    // on a key the index's static `where` already fixes — the latter is how a
    // filtered index becomes routable at all: `count({ status, archived: false })`
    // against `by: ["status"], where: { archived: false }` is exactly the counter's
    // question, even though `archived` is not a by-key.
    const resolved = parseRequestedEqKeys(requested, (key) => by.includes(key) || (staticWhere !== undefined && key in staticWhere));

    if (resolved === undefined) {
        return undefined;
    }

    // Every by-key must be pinned — the counter is partitioned by all of them.
    for (const key of by) {
        if (!(key in resolved)) {
            return undefined;
        }
    }

    return staticWhereIsImplied(staticWhere, resolved) ? resolved : undefined;
};

/**
 * Derive the constrained key fragment for a groupBy indexed path. Returns
 * `undefined` when the request is non-routable (boolean combinators,
 * extra-field where, non-`eq` operators, an index `where` the request does not
 * imply). Unlike `planAggregateLookup`, an unfiltered request is OK — the result
 * is an empty partial that the caller turns into a "walk the whole companion"
 * scan.
 *
 * Only `by`-fields land in the returned partial. The caller counts its keys
 * against the index's `by` arity to choose between the single-row lookup and the
 * whole-companion walk, and it hands the partial back as the answer's group key
 * — folding a static-`where` key in inflated that count and put a non-grouped
 * field in the caller's key tuple. An unfiltered `groupBy` over a filtered index
 * then took the single-row branch with a `by`-tuple of nulls and returned no
 * groups at all.
 * @returns the constrained by-key fragment for the groupBy indexed path, or `undefined` when the request is non-routable
 */
const collectPartialKey = (
    index: AggregateIndexDefinitionLike,
    requestedWhere: Record<string, unknown> | undefined,
    byFields: ReadonlySet<string>,
): Record<string, unknown> | undefined => {
    const staticWhere = index.where;
    const resolved = parseRequestedEqKeys(requestedWhere ?? {}, (key) => byFields.has(key) || (staticWhere !== undefined && key in staticWhere));

    if (resolved === undefined || !staticWhereIsImplied(staticWhere, resolved)) {
        return undefined;
    }

    return Object.fromEntries(Object.entries(resolved).filter(([key]) => byFields.has(key)));
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
const selectIndexForCount = (
    indexes: ReadonlyArray<AggregateIndexDefinitionLike>,
    requestedWhere: Record<string, unknown> | undefined,
): undefined | { index: AggregateIndexDefinitionLike; key: Record<string, unknown> } => selectIndexForReducer(indexes, "count", undefined, requestedWhere);

/**
 * Generalised version of {@link selectIndexForCount} for non-`count` reducers.
 * The match additionally requires the index's `op` AND `field` agree with the
 * request — `aggregate({ op: "sum", field: "seq" })` needs an
 * `aggregateIndex({ op: "sum", field: "seq" })`. Same `by`-prefer-wider tiebreak.
 */
const selectIndexForAggregate = (
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
 * - `op` (and `field`, when not `count`) agree with the request,
 * - the requested `where` keys are a subset of `by` (we filter the
 * companion by `__key__`); arbitrary predicates fall back to scan,
 * - the index's static `where` (if any) is satisfied by the request.
 *
 * Returns the index and the partial key the request constrains (may be
 * empty for an unfiltered groupBy — meaning "read every counter row").
 * @returns the matching index and partial key, or `undefined` when no index covers the request
 */
const selectIndexForGroupBy = (
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

export { CountRlsUnsupportedError, mergeWhere, planAggregateLookup, selectIndexForAggregate, selectIndexForCount, selectIndexForGroupBy };

export {
    type AggregateIndexDefinitionLike,
    type AggregateOp,
    type AggregateOptions,
    type AggregateResult,
    type GroupByEntry,
    type GroupByOptions,
    type RestrictableQueryOptions,
} from "./schema-types";
