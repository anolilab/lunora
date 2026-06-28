/**
 * Shape authoring API — declarative **partial replication** (the local-first
 * sync engine, Phase 3).
 *
 * A shape names a table plus a predicate (`where`) and an optional column
 * projection. A client subscribes to a shape by *name* + validated `args`; the
 * DO resolves the trusted `where(ctx, args)` server-side and AND-composes it
 * with the table's RLS read base-where, then streams the matching rowset and
 * live row-op pokes. Because the predicate runs on the DO with a `ctx` the
 * client can't forge (identity/auth), a shape is a *read-as-permission*: the
 * client chooses which partition to replicate, the server decides which rows it
 * is allowed to see.
 *
 * The returned object carries a `__lunoraShape` brand so `@lunora/codegen` can
 * discover declarations through the type checker (mirroring `defineMigration`'s
 * `__lunoraMigration` brand and the procedure builder's `__lunoraProcedure`
 * brand) and emit them into a `LUNORA_SHAPES` registry the DO resolves
 * subscriptions against.
 *
 * Shapes are declared in `lunora/shapes.ts`.
 */

import type { InferValidatorMap, ValidatorMap } from "@lunora/values";

import { validateArgs } from "./functions";
import type { WhereInput } from "./rls/types";
import type { QueryCtx as QueryContext } from "./types";

/**
 * A shape declaration. `where` receives the trusted procedure context and the
 * validated client args and returns the same {@link WhereInput} shape the RLS
 * DSL uses, so the DO can AND-merge it with the table's read base-where via the
 * existing where-compiler (zero second predicate implementation).
 */
export interface ShapeDefinition<Args extends ValidatorMap = ValidatorMap, Context = QueryContext> {
    /**
     * Validator for the client-supplied shape parameters. Validated on the DO
     * before `where` runs, so a malformed `args` envelope is rejected at the
     * subscription boundary rather than silently widening the partition. Omit
     * for a parameterless shape.
     */
    readonly args?: Args;

    /**
     * Project the replicated rows to these columns (the system columns `_id` and
     * `_creationTime` are always included). Omit to replicate every column. An
     * empty array is rejected — it would replicate no data, which is never the
     * intent.
     */
    readonly columns?: ReadonlyArray<string>;

    /** Logical table this shape replicates a partition of. */
    readonly table: string;

    /**
     * Predicate selecting the rows this shape replicates. AND-composed with the
     * table's RLS read base-where on the DO. Runs server-side with a trusted
     * `ctx` (identity/auth the client can't forge) and the validated client
     * `args`; returns a {@link WhereInput} using the same operator set as the
     * SQL compiler (`eq`/`in`/`lt`/… + `AND`/`OR`/`NOT`).
     */
    readonly where: (context: Context, args: InferValidatorMap<Args>) => WhereInput;
}

/** A {@link ShapeDefinition} plus the codegen discovery marker and a dispatch-shaped `compileWhere`. */
export interface RegisteredShape<Args extends ValidatorMap = ValidatorMap, Context = QueryContext> extends ShapeDefinition<Args, Context> {
    readonly __lunoraShape: true;

    /**
     * Validate `rawArgs`, then evaluate `where` under the trusted `ctx` and
     * return its {@link WhereInput}. Used by the generated DO's `resolveShape`
     * override: `ctx` is erased to `unknown` at this dispatch boundary (the DO
     * builds it from the socket's verified identity and hands it back as the
     * concrete {@link QueryContext} the predicate expects), exactly like
     * `RegisteredLunoraFunction.handler` erases its context.
     */
    readonly compileWhere: (context: unknown, rawArgs: Record<string, unknown>) => WhereInput;
}

/** Declare a replication shape. See the module docs for runtime semantics. */
export const defineShape = <Args extends ValidatorMap = ValidatorMap, Context = QueryContext>(
    definition: ShapeDefinition<Args, Context>,
): RegisteredShape<Args, Context> => {
    if (definition.table.trim() === "") {
        throw new Error("defineShape: `table` must be a non-empty string");
    }

    if (definition.columns?.length === 0) {
        throw new Error("defineShape: `columns` must list at least one column when provided");
    }

    const compileWhere = (context: unknown, rawArgs: Record<string, unknown>): WhereInput => {
        const parsed = validateArgs(definition.args ?? ({} as Args), rawArgs);

        return definition.where(context as Context, parsed);
    };

    return { __lunoraShape: true, ...definition, compileWhere };
};
