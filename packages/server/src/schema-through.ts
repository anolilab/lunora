/**
 * Load-time rules for many-to-many relations (`r.many(target, { through })`).
 *
 * A through relation is only as sound as its join table: the join table must exist, `from` and `to` must be two
 * different required `v.id` columns pointing at the owner and the target, and a unique index over exactly that pair
 * must make a link a single row. Without the index a double `connect` is two rows and every read through the relation
 * returns the target twice. Run by `defineSchema` and again by `mergeSchemaExtension` over the merged set.
 */
import { LunoraError } from "@lunora/errors";
import type { Validator } from "@lunora/values";

import { hasUniquePairIndex } from "../../../shared/unique-pair-index";
import type { TableDefinition, ThroughRelationDefinition } from "./types";

/** The table a bare, required `v.id("t")` column points at, or `undefined` for any other validator (optional, nullable, a union, …). */
const requiredIdTarget = (validator: Validator | undefined): string | undefined => {
    const tableName = validator?.kind === "id" ? (validator as { _meta?: { tableName?: unknown } })._meta?.tableName : undefined;

    return typeof tableName === "string" ? tableName : undefined;
};

/** Check one through relation against its join table. */
const validateThroughRelation = (tables: Record<string, TableDefinition>, tableName: string, name: string, relation: ThroughRelationDefinition): void => {
    const { from, table: joinName, to } = relation.through;
    const label = `defineSchema: relation "${name}" on table "${tableName}" (through "${joinName}")`;
    const join = tables[joinName];

    if (join === undefined) {
        throw new LunoraError("INTERNAL", `${label} names a join table that is not declared`);
    }

    if (tables[relation.table] === undefined) {
        throw new LunoraError("INTERNAL", `${label} targets "${relation.table}", which is not declared`);
    }

    if (from === to) {
        throw new LunoraError("INTERNAL", `${label}: "from" and "to" both name "${from}"; a link needs two different columns`);
    }

    for (const [column, expected] of [
        [from, tableName],
        [to, relation.table],
    ] as const) {
        if (requiredIdTarget(join.shape[column]) !== expected) {
            throw new LunoraError("INTERNAL", `${label}: "${joinName}.${column}" must be a required v.id("${expected}") column`);
        }
    }

    if (!hasUniquePairIndex(join.indexes, from, to)) {
        throw new LunoraError(
            "INTERNAL",
            `${label} needs a unique index over ("${from}", "${to}") on "${joinName}": ${JSON.stringify(`.index("by_${from}_${to}", ["${from}", "${to}"], { unique: true })`)}. Without it a repeated connect stores the same link twice.`,
        );
    }
};

/** Validate every through relation in `tables`; see the module docblock. */
const validateThroughRelations = (tables: Record<string, TableDefinition>): void => {
    for (const [tableName, table] of Object.entries(tables)) {
        for (const [name, relation] of Object.entries(table.relationMap)) {
            if (relation.through !== undefined) {
                validateThroughRelation(tables, tableName, name, relation);
            }
        }
    }
};

export default validateThroughRelations;
