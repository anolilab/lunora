import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * A correctness lint: every relation declared via `.relations((r) => …)` names a
 * target table, which must exist in the schema. A target that resolves to no
 * table is a typo or a reference to a table that was removed/renamed — the
 * relation can never load. Caught here at codegen time rather than at runtime.
 *
 * (Extension tables are already namespaced and their relation targets rewritten
 * by the time the schema reaches a lint, so a surviving unknown target is a real
 * miss, not an unresolved cross-package reference.)
 */
const relationReferencesUnknownTable: Lint = {
    categories: ["SCHEMA"],
    description: "A relation targets a table that does not exist in the schema. The relation can never load — the target is a typo or a removed/renamed table.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "relation_references_unknown_table",
    remediation: "Fix the target table name in the relation, or add the missing table to the schema.",
    run: (context) => {
        const tableNames = new Set(context.schema.tables.map((table) => table.name));

        return context.schema.tables.flatMap((table) =>
            table.relations
                .filter((relation) => !tableNames.has(relation.table))
                .map((relation) =>
                    emit(relationReferencesUnknownTable, {
                        cacheKey: `relation_references_unknown_table:${table.name}:${relation.name}`,
                        detail: `Relation "${relation.name}" on table "${table.name}" targets table "${relation.table}", which does not exist in the schema.`,
                        metadata: { relation: relation.name, table: table.name, target: relation.table },
                    }),
                ),
        );
    },
    source: "static",
    title: "Relation references unknown table",
};

export default relationReferencesUnknownTable;
