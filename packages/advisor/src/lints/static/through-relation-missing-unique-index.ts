import { hasUniquePairIndex } from "../../../../../shared/unique-pair-index";
import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A correctness lint for many-to-many relations: the join table behind
 * `r.many(target, { through: { table, from, to } })` must carry a unique index over
 * exactly `(from, to)`.
 *
 * Without it a link is not a single row: a repeated `connect` stores the same pair
 * twice, and every read through the relation then returns the target twice. The
 * index is also what makes `set` a diff rather than a rewrite. `defineSchema` throws
 * on the same condition at load; this reports it at codegen time, before the app runs.
 */
const throughRelationMissingUniqueIndex: Lint = {
    categories: ["SCHEMA"],
    description:
        "A many-to-many relation's join table has no unique index over its two keys, so the same link can be stored twice and every read through the relation returns the target twice.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "through_relation_missing_unique_index",
    remediation: 'Add a unique index over the two keys on the join table, e.g. `.index("byPostTag", ["postId", "tagId"], { unique: true })`.',
    run: (context) => {
        const tablesByName = new Map(context.schema.tables.map((table) => [table.name, table]));

        return context.schema.tables.flatMap((table) =>
            table.relations.flatMap((relation) => {
                if (relation.through === undefined) {
                    return [];
                }

                const { from, table: joinName, to } = relation.through;
                const join = tablesByName.get(joinName);

                // An unknown join table is `relation_references_unknown_table`'s job.
                if (join === undefined) {
                    return [];
                }

                if (
                    hasUniquePairIndex(
                        join.indexes.filter((index) => index.kind === "index"),
                        from,
                        to,
                    )
                ) {
                    return [];
                }

                return [
                    emit(throughRelationMissingUniqueIndex, {
                        cacheKey: `through_relation_missing_unique_index:${table.name}:${relation.name}`,
                        detail: `Relation "${relation.name}" on table "${table.name}" goes through "${joinName}", which has no unique index over ("${from}", "${to}"). A repeated connect stores the same link twice.`,
                        metadata: {
                            relation: relation.name,
                            suggestedIndex: { fields: [from, to], name: `by_${from}_${to}`, unique: true },
                            table: joinName,
                        },
                    }),
                ];
            }),
        );
    },
    source: "static",
    title: "Through relation missing unique index",
};

export default throughRelationMissingUniqueIndex;
