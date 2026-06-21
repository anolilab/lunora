import emit from "../../finding";
import type { AdvisorRelation, AdvisorTable } from "../../schema";
import type { Lint } from "../../types";
import { tableColumnSet } from "../helpers";

/** One unresolved relation column: which side it was used on, the column, and the table it should belong to. */
interface ColumnProblem {
    column: string;
    owner: string;
    side: "field" | "references";
}

/**
 * Resolve which of a relation's wired columns are missing. A relation joins a
 * foreign-key column to a referenced column; for a `one` relation the FK lives
 * on the holder and `references` (default `_id`) on the target, for `many` it is
 * reversed. Returns no problems when the target table is unknown — that case is
 * owned by `relation_references_unknown_table`, so the two lints don't both fire.
 */
const missingColumns = (
    byName: Map<string, AdvisorTable>,
    columnsOf: (table: AdvisorTable) => ReadonlySet<string>,
    holder: AdvisorTable,
    relation: AdvisorRelation,
): ColumnProblem[] => {
    const target = byName.get(relation.table);

    if (!target) {
        return [];
    }

    const fkTable = relation.kind === "one" ? holder : target;
    const referencedTable = relation.kind === "one" ? target : holder;
    const problems: ColumnProblem[] = [];

    if (!columnsOf(fkTable).has(relation.field)) {
        problems.push({ column: relation.field, owner: fkTable.name, side: "field" });
    }

    if (!columnsOf(referencedTable).has(relation.references)) {
        problems.push({ column: relation.references, owner: referencedTable.name, side: "references" });
    }

    return problems;
};

/**
 * A correctness lint covering the columns a relation wires together: the FK
 * `field` and the `references` column must each exist on their respective
 * tables, or the join can never resolve. Caught here at codegen time rather
 * than as a runtime failure.
 */
const relationReferencesUnknownField: Lint = {
    categories: ["SCHEMA"],
    description: "A relation references a foreign-key or referenced column that is not declared on its table, so the join can never resolve.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "relation_references_unknown_field",
    remediation: "Fix the `field` / `references` column name in the relation, or add the missing column.",
    run: (context) => {
        const byName = new Map<string, AdvisorTable>(context.schema.tables.map((table) => [table.name, table]));
        const columnsCache = new Map<AdvisorTable, ReadonlySet<string>>();
        const columnsOf = (table: AdvisorTable): ReadonlySet<string> => {
            let columns = columnsCache.get(table);

            if (!columns) {
                columns = tableColumnSet(table);
                columnsCache.set(table, columns);
            }

            return columns;
        };

        return context.schema.tables.flatMap((table) =>
            table.relations.flatMap((relation) =>
                missingColumns(byName, columnsOf, table, relation).map((problem) =>
                    emit(relationReferencesUnknownField, {
                        cacheKey: `relation_references_unknown_field:${table.name}:${relation.name}:${problem.side}`,
                        detail: `Relation "${relation.name}" on table "${table.name}" uses ${problem.side} "${problem.column}", which is not declared on table "${problem.owner}".`,
                        metadata: { column: problem.column, owner: problem.owner, relation: relation.name, side: problem.side, table: table.name },
                    }),
                ),
            ),
        );
    },
    source: "static",
    title: "Relation references unknown field",
};

export default relationReferencesUnknownField;
