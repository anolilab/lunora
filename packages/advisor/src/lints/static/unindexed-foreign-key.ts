import emit from "../../finding";
import type { Lint } from "../../types";

/** The implicit primary-key column; it is always indexed, so an FK onto it needs no extra index. */
const PRIMARY_KEY = "_id";

/** Convert an FK column into a conventional index name, e.g. `authorId` → `byAuthorId`. */
const suggestIndexName = (field: string): string => `by${field.charAt(0).toUpperCase()}${field.slice(1)}`;

/**
 * Cirrus port of splinter's `0001_unindexed_foreign_keys`.
 *
 * A `one` (many-to-one) relation declares a foreign-key column (`relation.field`)
 * on the holder table pointing at the target's `references` column. If no index
 * leads with that column, every read that filters or joins on the FK degrades to
 * a full table scan — the canonical silent performance cliff as a table grows.
 *
 * Coverage follows SQLite's leftmost-prefix rule: a composite index
 * `["authorId", "createdAt"]` covers lookups on `authorId`, so the FK is
 * satisfied when it is the *leading* column of any declared index. `many`
 * relations are skipped here — their FK lives on the opposite table and is
 * caught when that table's own `one` side is audited.
 */
const unindexedForeignKey: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A foreign-key column declared by a `one` relation has no index leading with it. Reads that filter or join on the column full-scan the table, which gets linearly slower as rows accumulate.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "unindexed_foreign_key",
    remediation: 'Add a secondary index leading with the FK column, e.g. `.index("byAuthorId", ["authorId"])`.',
    run: (context) => {
        const findings = [];

        for (const table of context.schema.tables) {
            // Columns that lead a btree secondary index are already covered. Only
            // `kind: "index"` qualifies — a search (FTS) or vector (ANN) index
            // does not serve an FK equality lookup, and a rank index's btree is
            // keyed on its sort columns, not arbitrary leading columns.
            const leadingIndexedColumns = new Set(
                table.indexes
                    .filter((index) => index.kind === "index")
                    .map((index) => index.fields[0])
                    .filter((field): field is string => field !== undefined),
            );

            for (const relation of table.relations) {
                // Only `one` relations put the FK column on *this* table.
                if (relation.kind !== "one") {
                    continue;
                }

                const fkColumn = relation.field;

                // The PK is always indexed; an FK onto it needs nothing extra.
                if (fkColumn === PRIMARY_KEY || leadingIndexedColumns.has(fkColumn)) {
                    continue;
                }

                const suggestedIndex = suggestIndexName(fkColumn);

                findings.push(
                    emit(unindexedForeignKey, {
                        cacheKey: `unindexed_foreign_key:${table.name}:${fkColumn}`,
                        detail: `Relation "${relation.name}" on table "${table.name}" references "${relation.table}" via column "${fkColumn}", which is not the leading column of any index. Reads filtering or joining on "${fkColumn}" full-scan "${table.name}".`,
                        metadata: {
                            fkColumn,
                            references: { column: relation.references, table: relation.table },
                            relation: relation.name,
                            suggestedIndex: { fields: [fkColumn], name: suggestedIndex },
                            table: table.name,
                        },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Unindexed foreign key",
};

export default unindexedForeignKey;
