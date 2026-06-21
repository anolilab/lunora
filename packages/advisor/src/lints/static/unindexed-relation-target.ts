import emit from "../../finding";
import type { Lint } from "../../types";
import { leadingIndexedColumns, PRIMARY_KEY, suggestIndexName } from "./fk-index";

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
        const findings = [];

        const tablesByName = new Map(context.schema.tables.map((table) => [table.name, table]));

        for (const table of context.schema.tables) {
            for (const relation of table.relations) {
                // Only `many` relations put the FK column on the *target* table.
                if (relation.kind !== "many") {
                    continue;
                }

                const target = tablesByName.get(relation.table);

                // An unknown target is `relation_references_unknown_table`'s job;
                // without the target's indexes/relations we cannot judge coverage.
                if (target === undefined) {
                    continue;
                }

                const fkColumn = relation.field;

                // The PK is always indexed; an FK onto it needs nothing extra.
                if (fkColumn === PRIMARY_KEY) {
                    continue;
                }

                // Strict complementarity: if the target declares its own `one`
                // relation on the same FK column, `unindexed_foreign_key` already
                // audits (and would flag) it — don't double-report.
                const coveredByForeignKeyLint = target.relations.some((targetRelation) => targetRelation.kind === "one" && targetRelation.field === fkColumn);

                if (coveredByForeignKeyLint || leadingIndexedColumns(target).has(fkColumn)) {
                    continue;
                }

                const suggestedIndex = suggestIndexName(fkColumn);

                findings.push(
                    emit(unindexedRelationTarget, {
                        cacheKey: `unindexed_relation_target:${relation.table}:${fkColumn}`,
                        detail: `Relation "${relation.name}" on table "${table.name}" is a to-many over "${relation.table}" via its column "${fkColumn}", which is not the leading column of any index on "${relation.table}". Relation predicates (\`some\`/\`none\`/\`every\`) and \`with:\` reads of "${relation.name}" full-scan "${relation.table}".`,
                        metadata: {
                            fkColumn,
                            references: { column: relation.references, table: table.name },
                            relation: relation.name,
                            suggestedIndex: { fields: [fkColumn], name: suggestedIndex },
                            table: relation.table,
                        },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Unindexed relation target",
};

export default unindexedRelationTarget;
