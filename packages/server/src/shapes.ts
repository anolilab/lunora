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
 *
 * Three ways to write the predicate, cheapest first:
 *
 * ```ts
 * // 1. Owner-scoped — the table declares `.ownedBy("userId")`; no predicate needed.
 * //    The filter comes from the socket's verified identity, so a client cannot
 * //    request another user's partition at all.
 * export const myNodes = defineShape({ owner: true, table: "nodes" });
 *
 * // 2. Owner-scoped plus a partition selector.
 * export const myArchivedNodes = defineShape({
 *     args: { archived: v.boolean() },
 *     owner: true,
 *     table: "nodes",
 *     where: (_ctx, { archived }) => ({ archived }),
 * });
 *
 * // 3. Fully custom. `deny()` (or `false`) is the denial branch — never `{}`,
 * //    which matches every row.
 * export const channelMessages = defineShape({
 *     args: { channelId: v.string() },
 *     table: "messages",
 *     where: (ctx, { channelId }) => (ctx.auth.userId === null ? deny() : { channelId }),
 * });
 * ```
 */

import { LunoraError } from "@lunora/errors";
import type { InferValidatorMap, ValidatorMap } from "@lunora/values";

import contextUserId from "./context-identity";
import { validateArgs } from "./functions";
import { deny, toWhereInput } from "./rls/predicates";
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

    /**
     * Restrict this shape to rows the **subscriber owns**, without writing the
     * predicate by hand.
     *
     * `true` uses the owning column declared by `.ownedBy(field)` on the table;
     * `"field"` names the owning column here instead (for a table that has no
     * `.ownedBy()`, or a shape that scopes by a different column).
     *
     * The derived predicate is `{ [field]: ctx.auth.userId }`, AND-composed with
     * the shape's own `where` when both are present, and an anonymous subscriber is denied
     * outright. Because the value comes from the socket's verified identity rather
     * than from `args`, a client cannot ask for another user's partition at all —
     * strictly safer than accepting a `userId` arg and comparing it.
     *
     * This is the primitive for the "every shape repeats the same ownership check"
     * pattern: with it, an owner-scoped shape needs no `where` at all.
     */
    readonly owner?: string | true;

    /** Logical table this shape replicates a partition of. */
    readonly table: string;

    /**
     * Predicate selecting the rows this shape replicates. AND-composed with the
     * table's RLS read base-where on the DO. Runs server-side with a trusted
     * `ctx` (identity/auth the client can't forge) and the validated client
     * `args`; returns a {@link WhereInput} using the same operator set as the
     * SQL compiler (`eq`/`in`/`lt`/… + `AND`/`OR`/`NOT`).
     *
     * `true`/`false` are accepted as sugar for "no further restriction" / "deny" —
     * `false` compiles to the vacuously-false predicate, so a denial branch can
     * never be mistyped as the everything-matches `{}`. Optional when `owner` is
     * set; otherwise required.
     */
    readonly where?: (context: Context, args: InferValidatorMap<Args>) => WhereInput | boolean;
}

/** A {@link ShapeDefinition} plus the codegen discovery marker and a dispatch-shaped `compileWhere`. */
export interface RegisteredShape<Args extends ValidatorMap = ValidatorMap, Context = QueryContext> extends ShapeDefinition<Args, Context> {
    readonly __lunoraShape: true;

    /**
     * Validate `rawArgs`, then evaluate the shape's predicate under the trusted
     * `ctx` and return its {@link WhereInput}. Used by the generated DO's
     * `resolveShape` override: `ctx` is erased to `unknown` at this dispatch
     * boundary (the DO builds it from the socket's verified identity and hands it
     * back as the concrete {@link QueryContext} the predicate expects), exactly like
     * `RegisteredLunoraFunction.handler` erases its context.
     *
     * `options.ownerField` carries the table's `.ownedBy(field)` column, which only
     * the caller (the DO, holding the schema) can look up — it is what resolves an
     * `owner: true` shape. Omitted for an `owner: "field"` or plain `where` shape.
     */
    readonly compileWhere: (context: unknown, rawArgs: Record<string, unknown>, options?: { ownerField?: string }) => WhereInput;
}

/** Declare a replication shape. See the module docs for runtime semantics. */
export const defineShape = <Args extends ValidatorMap = ValidatorMap, Context = QueryContext>(
    definition: ShapeDefinition<Args, Context>,
): RegisteredShape<Args, Context> => {
    if (definition.table.trim() === "") {
        throw new LunoraError("INTERNAL", "defineShape: `table` must be a non-empty string");
    }

    if (definition.columns?.length === 0) {
        throw new LunoraError("INTERNAL", "defineShape: `columns` must list at least one column when provided");
    }

    if (!definition.where && definition.owner === undefined) {
        throw new LunoraError(
            "INTERNAL",
            `defineShape: shape on table "${definition.table}" needs a \`where\` predicate or an \`owner\` (\`owner: true\` uses the table's .ownedBy(field), \`owner: "field"\` names the column) — a shape with neither would replicate the whole table`,
        );
    }

    const compileWhere = (context: unknown, rawArgs: Record<string, unknown>, options?: { ownerField?: string }): WhereInput => {
        const parsed = validateArgs(definition.args ?? ({} as Args), rawArgs);
        const shapeWhere = definition.where ? toWhereInput(definition.where(context as Context, parsed)) : undefined;

        if (definition.owner === undefined) {
            // Guaranteed by the constructor guard above.
            return shapeWhere as WhereInput;
        }

        const ownerField = definition.owner === true ? options?.ownerField : definition.owner;

        if (ownerField === undefined || ownerField === "") {
            throw new LunoraError(
                "INTERNAL",
                `defineShape: shape on table "${definition.table}" declares \`owner: true\` but the table has no \`.ownedBy(field)\` — add it to the table, or name the column directly with \`owner: "field"\``,
            );
        }

        const userId = contextUserId(context);

        // No verified identity ⇒ nothing is owned. Deny outright rather than
        // filtering on a nullish value, which a nullable owner column would match.
        if (userId === undefined) {
            return deny();
        }

        const ownerWhere: WhereInput = { [ownerField]: userId };

        return shapeWhere === undefined ? ownerWhere : { AND: [ownerWhere, shapeWhere] };
    };

    return { __lunoraShape: true, ...definition, compileWhere };
};
