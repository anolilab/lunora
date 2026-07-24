/**
 * Shared aggregate-SQL helpers used by both the DO ctx-db (`ctx-db.ts`) and
 * the D1 ctx-db twin (`@lunora/d1`'s `d1-ctx-db.ts`).
 *
 * These four pure helpers were previously duplicated in both files and are
 * now consolidated here to ensure that a bug fix or a tightening of the SQL
 * allowlist is applied to both backends simultaneously. In particular,
 * `aggregateSqlFunction` + `AGGREGATE_SQL_FUNCTION` are the SQL-injection
 * guard that prevents an off-list `op` from being concatenated into a query
 * string — having a single definition is the strongest available guarantee
 * that both backends enforce the same allowlist.
 */

import { LunoraError } from "@lunora/errors";

import type { RestrictableQueryOptions, SchedulerLike } from "./schema-types";
import type { WhereInput } from "./where-types";

/** Marker keys distinguishing a restrictable-query option set from a bare `WhereInput` tree. */
const COUNT_OPTION_KEYS = new Set(["baseWhere", "relationBaseWhere", "restrictsCounts", "where"]);

/**
 * Cheap predicate test against a flat literal `where` (the shape baked into
 * an `aggregateIndex.where`). Only handles literal equality and `{ eq: … }` —
 * the full operator vocabulary stays in the SQL compiler. Used during counter
 * maintenance to skip rows that don't qualify for a filtered aggregate.
 */
export const matchesStaticWhere = (document: Record<string, unknown>, predicate: Record<string, unknown>): boolean => {
    for (const [field, expected] of Object.entries(predicate)) {
        const actual = document[field];

        if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
            const operatorKeys = Object.keys(expected);

            if (operatorKeys.length === 1 && operatorKeys[0] === "eq") {
                if (actual !== (expected as { eq: unknown }).eq) {
                    return false;
                }

                continue;
            }

            return false;
        }

        if (actual !== expected) {
            return false;
        }
    }

    return true;
};

/**
 * Disambiguate the `count(table, ?)` arg. The legacy positional is a
 * `WhereInput` tree; the new shape is `{ where, baseWhere, restrictsCounts }`.
 * A value is treated as the options shape when every own key is a marker —
 * otherwise it's a `where` literal. Boolean combinators (`AND`/`OR`/`NOT`)
 * keep it on the `where` side.
 */
export const normalizeCountArgument = (argument: RestrictableQueryOptions | undefined | WhereInput): RestrictableQueryOptions => {
    if (argument === undefined) {
        return {};
    }

    if (typeof argument !== "object" || Array.isArray(argument)) {
        return { where: argument as WhereInput };
    }

    const keys = Object.keys(argument);

    if (keys.length === 0) {
        return {};
    }

    if (keys.every((key) => COUNT_OPTION_KEYS.has(key))) {
        return argument as RestrictableQueryOptions;
    }

    return { where: argument as WhereInput };
};

/**
 * Closed allowlist mapping each reducer `op` to the literal SQL function it may
 * emit. `AggregateOp` is a compile-time type only — a caller reaching the
 * runtime with an off-list `op` (forged wire payload, `as any`) would otherwise
 * have it concatenated straight into the SQL string. Routing every reducer
 * through this table guarantees only a known function name reaches the query.
 */
export const AGGREGATE_SQL_FUNCTION: Record<string, string> = { avg: "AVG", count: "COUNT", max: "MAX", min: "MIN", sum: "SUM" };

/** Resolve a reducer `op` to its SQL function, throwing on an off-allowlist op. */
export const aggregateSqlFunction = (op: string): string => {
    const sqlFunction = AGGREGATE_SQL_FUNCTION[op];

    if (sqlFunction === undefined) {
        throw new LunoraError("INTERNAL", `unknown aggregate op "${op}": expected one of ${Object.keys(AGGREGATE_SQL_FUNCTION).join(", ")}`);
    }

    return sqlFunction;
};

/**
 * Default `ctx.scheduler` stub wired when no scheduler is configured — every
 * method throws a clear error. Shared by both `createShardCtxDb` (DO) and
 * `createD1CtxDb` (D1).
 */
export const throwingScheduler: SchedulerLike = {
    runAfter: () => {
        throw new LunoraError("INTERNAL", "ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to the ctx-db factory.");
    },
    runAt: () => {
        throw new LunoraError("INTERNAL", "ctx.scheduler: no scheduler configured for triggers. Pass `scheduler` to the ctx-db factory.");
    },
};
