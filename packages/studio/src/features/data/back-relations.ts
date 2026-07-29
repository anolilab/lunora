import type { BackRelation, ColumnMeta } from "../../lib/admin";

/**
 * Reverse relations pointing at `table`, derived from schema metadata the data
 * browser already holds.
 *
 * No server round trip is needed to FIND these: `describeTables` returns every
 * table's columns with their `ref` target, so "who points at me" is a scan of
 * that map. Only the per-row COUNTS need the server.
 *
 * A self-referencing table (a `parentId` on the same table) is included — a tree
 * table's child count is exactly the kind of thing an operator wants — but the
 * browsed table's own forward columns are not otherwise confused for reverse
 * edges, because the match is on `ref`, not on name.
 */
const backRelationsFor = (table: string, columnsByTable: Readonly<Record<string, ReadonlyArray<ColumnMeta>>>): BackRelation[] => {
    const relations: BackRelation[] = [];

    for (const [childTable, columns] of Object.entries(columnsByTable)) {
        for (const column of columns) {
            if (column.ref === table) {
                relations.push({ column: column.name, table: childTable });
            }
        }
    }

    // Stable order so the columns menu doesn't reshuffle between loads.
    relations.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

    return relations;
};

/** Stable identity for a reverse edge, used as a toggle key and a column id. */
const backRelationKey = (relation: BackRelation): string => `${relation.table}.${relation.column}`;

export { backRelationKey, backRelationsFor };
