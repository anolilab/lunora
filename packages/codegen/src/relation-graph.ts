/**
 * Schema-derived relation EDGES — the directed graph a `v.id("target")` column
 * already describes but that nothing used to read.
 *
 * `v.id("tickets")` records its target table in the validator's metadata bag
 * (`@lunora/values`' `v.id`), and `schema-drift` already reads it to notice a
 * retargeted foreign key. This module turns the same information into a
 * traversable edge SET: one directed edge per `v.id` column, from the table
 * that HOLDS the column to the table the id points at.
 *
 * Each edge is addressable by name — `"tickets.customerId"`, the holder table
 * plus its column — because the name is what a caller passes to
 * `ctx.db.related({ edges: [...] })` to restrict a traversal to the hops it
 * cares about. A column name is unique within its table, so the pair is unique
 * within the schema.
 *
 * **Why this exists at codegen time.** `@lunora/shard-engine` derives the same
 * edge set at runtime off the live `defineSchema` validators — that is what
 * `ctx.db.related` walks. This IR-side twin answers a question the runtime
 * cannot: whether the app declares a relation graph AT ALL, which is the
 * `PlatformSignals` input that lets `gateAgainstMatrix` refuse a target whose
 * matrix rates `relationGraph` unsupported. Both sides name edges identically
 * (`${sourceTable}.${column}`) and both are pinned by tests; they read
 * different inputs (static AST IR vs runtime validators) for the same reason
 * every `*Like` structural mirror in `@lunora/shard-engine` does.
 */
import type { SchemaIR, ValidatorIR } from "./ir";

/**
 * One directed foreign-key edge: `sourceTable.column` → `targetTable`.
 *
 * The direction is the one the DATA points in — the row carrying the column is
 * the source — which is also the direction `ctx.db.related`'s `"out"` follows.
 */
interface RelationEdge {
    /**
     * `true` when the column is a `v.array(v.id(...))` — one row holds MANY
     * target ids rather than one.
     */
    array: boolean;
    /** The `v.id(...)` column on {@link RelationEdge.sourceTable}. */
    column: string;
    /** The addressable edge-type name: `` `${sourceTable}.${column}` ``. */
    name: string;
    /** The table whose rows carry the foreign key. */
    sourceTable: string;
    /** The table the foreign key points at — the `v.id("…")` argument. */
    targetTable: string;
}

/**
 * The `v.id` target of a column validator, unwrapping the wrappers a foreign
 * key is legitimately declared under, or `undefined` when the column is not a
 * foreign key.
 *
 * `v.optional(v.id("t"))` and `v.array(v.id("t"))` (and the two nested either
 * way) are as much an edge as a bare `v.id("t")` — the first is a nullable FK,
 * the second a to-many one — so both wrappers are traversed. Anything else
 * (`v.object`, `v.union`, `v.record`) is deliberately NOT: an id buried in a
 * union is not a column the query layer can filter on, so an edge derived from
 * one would name a hop no traversal could actually take.
 */
const foreignKeyTargetOf = (validator: ValidatorIR): { array: boolean; targetTable: string } | undefined => {
    if (validator.kind === "id") {
        return validator.tableName === undefined ? undefined : { array: false, targetTable: validator.tableName };
    }

    if (validator.kind !== "array" && validator.kind !== "optional") {
        return undefined;
    }

    const inner = validator.inner === undefined ? undefined : foreignKeyTargetOf(validator.inner);

    if (inner === undefined) {
        return undefined;
    }

    return { array: inner.array || validator.kind === "array", targetTable: inner.targetTable };
};

/**
 * Derive every foreign-key edge the schema declares, in a deterministic order
 * (declaration order of tables, then of columns within a table).
 *
 * An edge whose target table is not declared in this schema is DROPPED. That is
 * not a lost edge but an unreachable one: `v.id("archive")` with no `archive`
 * table names a hop no read could serve, and keeping it would put an
 * unresolvable edge name in the surface a caller picks `edges` from.
 * @param schema The discovered schema IR.
 * @returns Every declared, resolvable foreign-key edge.
 */
const deriveRelationEdges = (schema: SchemaIR): RelationEdge[] => {
    const declared = new Set(schema.tables.map((table) => table.name));
    const edges: RelationEdge[] = [];

    for (const table of schema.tables) {
        for (const [column, validator] of Object.entries(table.shape)) {
            const target = foreignKeyTargetOf(validator);

            if (target === undefined || !declared.has(target.targetTable)) {
                continue;
            }

            edges.push({
                array: target.array,
                column,
                name: `${table.name}.${column}`,
                sourceTable: table.name,
                targetTable: target.targetTable,
            });
        }
    }

    return edges;
};

export type { RelationEdge };
export { deriveRelationEdges };
