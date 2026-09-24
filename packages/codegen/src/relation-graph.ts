/**
 * Does the app's schema declare a relation graph at all?
 *
 * That single boolean is the whole job here. It is the `relationGraph`
 * `PlatformSignals` input, which lets `gateAgainstMatrix` refuse a target
 * whose matrix rates the traversal `unsupported` instead of emitting a
 * `ctx.db.related` that fails on the first hop.
 *
 * **Why it is not the edge SET.** `@lunora/shard-engine` derives the real edge
 * set at runtime, off the live `defineSchema` validators — that is what
 * `ctx.db.related` walks, and it is the only derivation whose output anything
 * consumes. This side used to derive its own, identically-named-and-shaped copy
 * (118 lines, a public `RelationEdge` export, an api-snapshot entry) and then
 * throw all of it away but `.length > 0`. Two derivations of the same fact, each
 * pinned by its own independent fixtures, with nothing comparing them: adding
 * `v.union` unwrapping to one would have silently desynced the codegen gate from
 * the runtime with every test green. So this keeps the QUESTION and drops the
 * duplicate answer, and `relation-graph.test.ts` cross-pins what remains against
 * `deriveRelationEdges` over one shared fixture.
 *
 * The inputs still differ — static AST IR here, runtime validators there — for
 * the same reason every `*Like` structural mirror in `@lunora/shard-engine`
 * does; only the DERIVATION is now single.
 */
import type { SchemaIR, ValidatorIR } from "./ir";

/**
 * The `v.id` target of a column validator, unwrapping the wrappers a foreign key
 * is legitimately declared under, or `undefined` when the column is not one.
 *
 * `v.optional(v.id("t"))` and `v.array(v.id("t"))` (and the two nested either
 * way) are as much an edge as a bare `v.id("t")` — the first is a nullable FK,
 * the second a to-many one — so both wrappers are traversed. Anything else
 * (`v.object`, `v.union`, `v.record`) is deliberately NOT: an id buried in a
 * union is not a column the query layer can filter on, so a graph derived from
 * one would claim hops no traversal could take.
 */
const foreignKeyTargetOf = (validator: ValidatorIR): string | undefined => {
    if (validator.kind === "id") {
        return validator.tableName;
    }

    if (validator.kind !== "array" && validator.kind !== "optional") {
        return undefined;
    }

    return validator.inner === undefined ? undefined : foreignKeyTargetOf(validator.inner);
};

/**
 * Whether `schema` declares at least one RESOLVABLE foreign key — a `v.id(...)`
 * column whose target table this schema also declares.
 *
 * The resolvability test is not incidental: `v.id("archive")` with no `archive`
 * table names a hop no read could serve, so a schema whose only `v.id` is
 * dangling declares no graph and must not be gated as if it did.
 * @param schema The discovered schema IR.
 * @returns `true` when at least one foreign-key edge is declared and resolvable.
 */
const schemaDeclaresRelationGraph = (schema: SchemaIR): boolean => {
    const declared = new Set(schema.tables.map((table) => table.name));

    return schema.tables.some((table) =>
        Object.values(table.shape).some((validator) => {
            const target = foreignKeyTargetOf(validator);

            return target !== undefined && declared.has(target);
        }),
    );
};

export default schemaDeclaresRelationGraph;
