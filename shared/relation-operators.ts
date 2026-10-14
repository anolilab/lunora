/**
 * The Prisma-style relation operator names, and the shape test that recognises a
 * relation node in a `where` tree.
 *
 * Lives here rather than in a package because three unrelated call sites need
 * it and none of them may depend on the others: the engine's predicate compiler
 * (`@lunora/shard-engine`), the RLS write-policy check and the mask where-scope
 * guard (both `@lunora/server`, which does not depend on the engine). Each had
 * grown its own copy of the same five names.
 *
 * That mattered because the copies are not equivalent in consequence. The mask
 * guard uses this to decide whether to DESCEND into a node; a name it does not
 * know is a node it walks straight past, which reopens the value oracle that
 * guard exists to close — silently, on the new operator only, with every
 * existing test still green. Adding a sixth operator has to be a one-line data
 * change, and this is the one line.
 */

/** The five relation operators. `@lunora/shard-engine` keys its per-operator metadata off this set, so the two cannot drift. */
const RELATION_OPERATOR_KEYS = ["every", "is", "isNot", "none", "some"] as const;

/** One of {@link RELATION_OPERATOR_KEYS}. */
type RelationOperator = (typeof RELATION_OPERATOR_KEYS)[number];

const RELATION_OPERATOR_SET: ReadonlySet<string> = new Set<string>(RELATION_OPERATOR_KEYS);

/**
 * A value is a relation predicate when it is a non-empty plain (non-array,
 * non-null) object whose EVERY key is a relation operator.
 *
 * "All keys known" is the same disambiguation the column-operator compiler
 * uses, and it is what keeps a column legitimately named `is` or `some` holding
 * an ordinary filter from being mistaken for a relation node. Structural on
 * purpose: the two `@lunora/server` callers hold no relation map, and a relation
 * node is identifiable by shape alone because the operator names do not collide
 * with the column-operator names (`eq`/`in`/`lt`/…).
 */
const isRelationPredicate = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }

    const keys = Object.keys(value);

    return keys.length > 0 && keys.every((key) => RELATION_OPERATOR_SET.has(key));
};

export { isRelationPredicate, RELATION_OPERATOR_KEYS, RELATION_OPERATOR_SET, type RelationOperator };
