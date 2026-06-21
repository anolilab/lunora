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

/**
 * Build a map from `parentTable → relations that point at it from child tables`.
 * A cascade impact walk starts at the deleted table and follows these "who
 * references me?" edges — the inverse of the FK direction.
 *
 * Only `cascade` and `restrict` relations are included; `set null` rows are not
 * deleted (the FK field is nulled), so they don't appear in a cascade impact
 * tree. The map is keyed by the **referenced** table (the parent being deleted)
 * and values are the relations declared on the **referencing** (child) table.
 */
const buildCascadeMap = (schema: AdvisorSchema): Map<string, AdvisorRelation[]> => {
    const map = new Map<string, AdvisorRelation[]>();

    for (const advisorTable of schema.tables) {
        for (const relation of advisorTable.relations) {
            // Only `one` relations carry the FK on the child table pointing at a parent.
            if (relation.kind !== "one") {
                continue;
            }

            // `set null` relations don't delete child rows — the FK field is set to
            // null instead. Exclude them: only cascade and restrict affect row existence.
            if (relation.onDelete === "set null" || relation.onDelete === undefined) {
                continue;
            }

            // The relation's `references` is the referenced (parent) table.
            const parent = relation.references;
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

export type { AdvisorRelation, AdvisorSchema, AdvisorTable } from "@lunora/advisor";
export { buildCascadeMap, walkCascade };
