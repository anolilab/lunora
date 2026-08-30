/**
 * Utilities for building and walking the foreign-key cascade graph that the
 * cascade-impact preview uses. Separated from the React component so pure
 * logic can be unit-tested without a DOM renderer.
 *
 * Re-exports the advisor schema types that the studio already depends on
 * (transitively, via `@lunora/advisor`) so the preview component has a single
 * import for all cascade-related types.
 */

import type { AdvisorRelation, AdvisorSchema } from "@lunora/advisor";

import type { ColumnMeta } from "./admin";

/**
 * Build the cascade graph's input from what the studio can actually see: the
 * `describeTables` column metadata every data-browser session already loads.
 *
 * `ColumnMeta.ref` names the FK target of a `v.id("target")` column, which is
 * the edge the impact walk follows. It does NOT carry the declared `onDelete`
 * action — that lives in the schema and is not on the admin wire — so every
 * relation here is emitted with `onDelete` UNSET, and the preview renders those
 * edges as "action not declared to the studio" rather than claiming a cascade it
 * cannot verify. A feeder that does know the action (a real
 * {@link AdvisorSchema}) sets it and the preview labels each edge exactly.
 */
const advisorSchemaFromColumns = (columnsByTable: Readonly<Record<string, ReadonlyArray<ColumnMeta>>>): AdvisorSchema => {
    return {
        tables: Object.entries(columnsByTable).map(([name, columns]) => {
            return {
                fields: columns.map((column) => column.name),
                indexes: [],
                name,
                relations: columns
                    .filter((column) => column.ref !== undefined)
                    .map((column): AdvisorRelation => {
                        return { field: column.name, kind: "one", name: column.name, references: column.ref as string, table: name };
                    }),
            };
        }),
    };
};

/**
 * Build a map from `parentTable → relations that point at it from child tables`.
 * A cascade impact walk starts at the deleted table and follows these "who
 * references me?" edges — the inverse of the FK direction.
 *
 * `set null` relations are excluded: those rows are not deleted (the FK field is
 * nulled), so they are not part of a delete's impact. Everything else is kept —
 * `cascade` and `restrict` because they decide whether the child row dies or
 * blocks the delete, and an edge with NO declared action because that is the
 * case an operator most needs to see: the child row survives holding an FK to a
 * row that no longer exists. The map is keyed by the **referenced** table (the
 * parent being deleted) and values are the relations declared on the
 * **referencing** (child) table.
 */
const buildCascadeMap = (schema: AdvisorSchema): Map<string, AdvisorRelation[]> => {
    const map = new Map<string, AdvisorRelation[]>();
    // `childTable:field` pairs already recorded per parent. The same edge declared
    // twice is still ONE edge; without this the preview renders a duplicate node
    // for it, doubling the apparent blast radius of the delete.
    const seen = new Set<string>();

    for (const advisorTable of schema.tables) {
        for (const relation of advisorTable.relations) {
            // Only `one` relations carry the FK on the child table pointing at a parent.
            if (relation.kind !== "one") {
                continue;
            }

            // `set null` relations don't delete child rows — the FK field is set to
            // null instead — so they are not part of the delete's impact. An edge
            // with no declared action IS kept: those rows are left pointing at a
            // deleted parent, which is exactly what the preview exists to show.
            if (relation.onDelete === "set null") {
                continue;
            }

            // The relation's `references` is the referenced (parent) table.
            const parent = relation.references;
            const edgeKey = `${parent}\u0000${advisorTable.name}\u0000${relation.field}`;

            if (seen.has(edgeKey)) {
                continue;
            }

            seen.add(edgeKey);

            const existing = map.get(parent) ?? [];

            // Include the relation with the child's table name so the walker knows
            // which table to read next.
            existing.push({ ...relation, table: advisorTable.name });
            map.set(parent, existing);
        }
    }

    return map;
};

/**
 * Walk a resolved cascade tree and collect all nodes for which `predicate`
 * returns true. Used by the dialog to detect restrict blockers and by tests to
 * traverse the tree.
 */
const walkCascade = <T extends { children: T[] }>(root: T, predicate: (node: T) => boolean): T[] => {
    const results: T[] = [];
    const queue: T[] = [root];

    while (queue.length > 0) {
        const node = queue.shift();

        if (node === undefined) {
            break;
        }

        if (predicate(node)) {
            results.push(node);
        }

        for (const child of node.children) {
            queue.push(child);
        }
    }

    return results;
};

export type { AdvisorRelation, AdvisorSchema } from "@lunora/advisor";
export { advisorSchemaFromColumns, buildCascadeMap, walkCascade };
