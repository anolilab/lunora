import emit from "../../finding";
import type { AdvisorRelation, AdvisorTable } from "../../schema";
import type { Lint } from "../../types";
import { leadingIndexedColumns, PRIMARY_KEY, suggestIndexName } from "./fk-index";

interface KeyHolder {
    column: string;
    references: string;
    table: string;
}

/**
 * Where a `many` relation's foreign-key columns live and which column of the declaring table they point at: one
 * column on the target table, or — for a many-to-many relation, which reads its join table by `from` and filters it
 * by `to` — two columns on the join table.
 */
const keyHolders = (relation: AdvisorRelation): KeyHolder[] =>
    relation.through === undefined
        ? [{ column: relation.field, references: relation.references, table: relation.table }]
        : [
              { column: relation.through.from, references: "_id", table: relation.through.table },
              { column: relation.through.to, references: "_id", table: relation.through.table },
          ];

/**
 * Is `column` already served on `target`? The PK is always indexed, an index leading with it covers it, and a `one`
 * relation declared there on the same column is audited by `unindexed_foreign_key` — strict complementarity, so the
 * two lints never double-report.
 */
const isIndexed = (target: AdvisorTable, column: string): boolean =>
    column === PRIMARY_KEY ||
    target.relations.some((relation) => relation.kind === "one" && relation.field === column) ||
    leadingIndexedColumns(target).has(column);

/**
 * The to-many counterpart of `unindexed_foreign_key`.
 *
 * A `many` relation declares its foreign-key column (`relation.field`) on the
 * target table — `users.posts = r.many("posts", { field: "authorId" })` puts
 * `authorId` on `posts`. A relation predicate over that relation (`{ posts: {
 * some|none|every: W } }` in a `where`/RLS policy) and a `with:` child load both
 * resolve by querying the target table on that FK column, so an unindexed FK
 * there is the same silent full-scan cliff `unindexed_foreign_key` warns about —
 * just on the other side of the relation.
 *
 * `unindexed_foreign_key` only audits a table's own `one` relations, so it
 * catches this column **only when the target table declares the inverse `one`
 * relation** (`posts.author = r.one("users", { field: "authorId" })`). A
 * one-directional `many` (declared on the parent, with no inverse `one` on the
 * child) slips through — that exact gap is this lint's job. To stay strictly
 * complementary it skips any FK the target already covers via its own `one`
 * relation (reported there) and only fires on the otherwise-unaudited column.
 */
const unindexedRelationTarget: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A `many` relation's foreign-key column on the target table has no index leading with it. Relation predicates (`some`/`none`/`every`) and `with:` child reads filter the target on that column, full-scanning it as rows accumulate.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "unindexed_relation_target",
    remediation: 'Add a secondary index on the target table leading with the FK column, e.g. `.index("byAuthorId", ["authorId"])`.',
    run: (context) => {
        const tablesByName = new Map(context.schema.tables.map((table) => [table.name, table]));

        return context.schema.tables.flatMap((table) =>
            table.relations
                // Only `many` relations put the FK column on another table than the one that declares them.
                .filter((relation) => relation.kind === "many")
                .flatMap((relation) =>
                    keyHolders(relation).flatMap((holder) => {
                        const target = tablesByName.get(holder.table);

                        // An unknown target is `relation_references_unknown_table`'s job;
                        // without the target's indexes/relations we cannot judge coverage.
                        if (target === undefined || isIndexed(target, holder.column)) {
                            return [];
                        }

                        return [
                            emit(unindexedRelationTarget, {
                                cacheKey: `unindexed_relation_target:${target.name}:${holder.column}`,
                                detail: `Relation "${relation.name}" on table "${table.name}" is a to-many over "${target.name}" via its column "${holder.column}", which is not the leading column of any index on "${target.name}". Relation predicates (\`some\`/\`none\`/\`every\`) and \`with:\` reads of "${relation.name}" full-scan "${target.name}".`,
                                metadata: {
                                    fkColumn: holder.column,
                                    references: { column: holder.references, table: table.name },
                                    relation: relation.name,
                                    suggestedIndex: { fields: [holder.column], name: suggestIndexName(holder.column) },
                                    table: target.name,
                                },
                            }),
                        ];
                    }),
                ),
        );
    },
    source: "static",
    title: "Unindexed relation target",
};

export default unindexedRelationTarget;
