import emit from "../../finding";
import type { Lint } from "../../types";
import { tableColumnSet } from "../helpers";

/**
 * A correctness lint with no splinter analogue — it exploits Lunora's static
 * edge: the schema is fully declared, so a typo'd index column is catchable at
 * codegen time rather than surfacing as a runtime error or a silently
 * never-matching index.
 *
 * Every index (secondary / search / rank / vector) names the columns it covers;
 * each must be a declared column of the table (or a system field). A reference
 * to an unknown column is almost always a typo or a column that was renamed
 * without updating the index.
 */
const indexReferencesUnknownField: Lint = {
    categories: ["SCHEMA"],
    description:
        "An index references a column that is not declared on its table. The index can never match, and the typo would otherwise surface only at runtime.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "index_references_unknown_field",
    remediation: "Fix the column name in the index declaration, or add the column to the table.",
    run: (context) =>
        context.schema.tables.flatMap((table) => {
            const columns = tableColumnSet(table);

            return table.indexes.flatMap((index) =>
                index.fields
                    .filter((field) => !columns.has(field))
                    .map((field) =>
                        emit(indexReferencesUnknownField, {
                            cacheKey: `index_references_unknown_field:${table.name}:${index.name}:${field}`,
                            detail: `Index "${index.name}" on table "${table.name}" references column "${field}", which is not declared on the table.`,
                            metadata: { field, index: index.name, indexKind: index.kind, table: table.name },
                        }),
                    ),
            );
        }),
    source: "static",
    title: "Index references unknown field",
};

export default indexReferencesUnknownField;
