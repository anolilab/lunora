import emit from "../../finding";
import type { AdvisorTable } from "../../schema";
import type { AdvisorTableSample } from "../../table-samples";
import type { Finding, Lint } from "../../types";

/**
 * The maximum number of violating-row examples surfaced per finding. Keeps the
 * detail string readable and the finding metadata bounded even on a table with
 * many violations.
 */
const MAX_EXAMPLE_IDS = 5;

/** Extract a row's `_id` as a string, or return `"?"` if absent / non-string. */
const rowId = (row: Record<string, unknown>): string => (typeof row["_id"] === "string" ? row["_id"] : "?");

/** Compose the truncation caveat suffix when a sample is capped. */
const truncatedSuffix = (capped: boolean, cap: number, phrase: string): string => (capped ? ` (sample capped at ${cap.toString()} rows — ${phrase})` : "");

/** Format a list of example ids into a readable summary. */
const formatExamples = (ids: string[], total: number): string => {
    const examples = ids.slice(0, MAX_EXAMPLE_IDS);
    const more = total - examples.length;
    const list = examples.map((id) => `"${id}"`).join(", ");

    return more > 0 ? `${list} (+${more.toString()} more)` : list;
};

// ── per-table check helpers ───────────────────────────────────────────────────

/**
 * Resolve the set of referenced key values a FK is checked against. For the
 * default `_id` reference the sample already exposes `existingIds`; a custom
 * `references` column (e.g. `one("users", { references: "slug" })`) is resolved
 * from the target's sampled rows — comparing against the `_id` set would flag
 * every row.
 */
const resolveReferenceValues = (referencedColumn: string, targetSample: AdvisorTableSample): ReadonlySet<string> => {
    if (referencedColumn === "_id") {
        return targetSample.existingIds;
    }

    const values = new Set<string>();

    for (const row of targetSample.rows) {
        const value = row[referencedColumn];

        if (value !== null && value !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-base-to-string -- referenced key column is a primitive from SQLite
            values.add(String(value));
        }
    }

    return values;
};

/** Check FK referential integrity for a single `one` relation on a sampled table. */
const checkFkRelation = (
    lint: Lint,
    sample: AdvisorTableSample,
    relation: AdvisorTable["relations"][number],
    targetSample: AdvisorTableSample,
): Finding | undefined => {
    if (relation.kind !== "one") {
        return undefined;
    }

    // A dangling reference can only be *proven* against the COMPLETE set of
    // target keys. When the target sample is truncated, a valid FK pointing at a
    // target row beyond the cap would be reported as dangling — a false positive
    // that could lead an operator to delete or re-link good data. Skip the check
    // entirely in that case (source truncation, below, is fine — it only means
    // more violations may exist).
    if (targetSample.truncated) {
        return undefined;
    }

    const referencedColumn = relation.references;
    const referenceValues = resolveReferenceValues(referencedColumn, targetSample);

    const fkColumn = relation.field;
    const danglingIds: string[] = [];

    for (const row of sample.rows) {
        const fkValue = row[fkColumn];

        // Null/undefined FK values are skipped — we can't distinguish optional
        // from non-optional from the AdvisorSchema alone, so we only flag
        // non-null values that don't resolve in the target sample.
        if (fkValue === null || fkValue === undefined) {
            continue;
        }

        // Safe coercion: fkValue originates from a SQLite row; FK id columns are
        // always strings in Lunora (v.id()), so String() is correct here.
        // eslint-disable-next-line @typescript-eslint/no-base-to-string -- id column is always a primitive string from SQLite
        const fkString = String(fkValue);

        if (!referenceValues.has(fkString)) {
            danglingIds.push(rowId(row));
        }
    }

    if (danglingIds.length === 0) {
        return undefined;
    }

    // Only source truncation remains possible here (the target is complete).
    const isTruncated = sample.truncated;
    const { cap } = sample;
    const referencedLabel = referencedColumn === "_id" ? `"${relation.table}"` : `"${relation.table}"."${referencedColumn}"`;
    const detail =
        `Table "${sample.table}": ${danglingIds.length.toString()} sampled row(s) have a dangling FK value in column "${fkColumn}" — ` +
        `the referenced ${referencedLabel} row does not exist. Row ids: ${formatExamples(danglingIds, danglingIds.length)}` +
        `${truncatedSuffix(isTruncated, cap, "more rows may exist beyond the window")}.`;

    return emit(lint, {
        cacheKey: `constraint_validator:fk:${sample.table}:${fkColumn}`,
        detail,
        metadata: {
            cap,
            column: fkColumn,
            count: danglingIds.length,
            examples: danglingIds.slice(0, MAX_EXAMPLE_IDS),
            kind: "fk",
            references: referencedColumn,
            referencesTable: relation.table,
            table: sample.table,
            truncated: isTruncated,
        },
    });
};

/**
 * Check NOT NULL violations for a single declared field on a sampled table.
 * `isRequired` must be `true` only for fields the schema declares as
 * non-optional and non-nullable; passing `false` short-circuits the check so
 * optional / nullable fields never produce false-positive findings.
 */
const checkNullField = (lint: Lint, sample: AdvisorTableSample, field: string, isRequired: boolean): Finding | undefined => {
    if (!isRequired) {
        return undefined;
    }
    const nullIds: string[] = [];

    for (const row of sample.rows) {
        const value = row[field];

        if (value === null || value === undefined) {
            nullIds.push(rowId(row));
        }
    }

    if (nullIds.length === 0) {
        return undefined;
    }

    const detail =
        `Table "${sample.table}": ${nullIds.length.toString()} sampled row(s) have a null/missing value in column "${field}", ` +
        `which is declared as non-optional. Row ids: ${formatExamples(nullIds, nullIds.length)}` +
        `${truncatedSuffix(sample.truncated, sample.cap, "more rows may exist beyond the window")}.`;

    return emit(lint, {
        cacheKey: `constraint_validator:null:${sample.table}:${field}`,
        detail,
        metadata: {
            cap: sample.cap,
            column: field,
            count: nullIds.length,
            examples: nullIds.slice(0, MAX_EXAMPLE_IDS),
            kind: "null",
            table: sample.table,
            truncated: sample.truncated,
        },
    });
};

/**
 * Build a `"|"`-delimited composite key for a row over `fields`.
 * Returns `undefined` when any field value is null/undefined (SQL UNIQUE allows
 * multiple nulls, so we skip null-containing rows).
 */
const compositeKey = (row: Record<string, unknown>, fields: ReadonlyArray<string>): string | undefined => {
    const parts: string[] = [];

    for (const field of fields) {
        const value = row[field];

        if (value === null || value === undefined) {
            return undefined;
        }

        parts.push(JSON.stringify(value));
    }

    return parts.join("|");
};

/** Accumulate duplicate ids from a composite-key collision into `duplicateIds`. */
const recordDuplicate = (id: string, existingId: string, duplicateIds: string[]): void => {
    if (!duplicateIds.includes(existingId)) {
        duplicateIds.push(existingId);
    }

    duplicateIds.push(id);
};

/** Check UNIQUE violations for a single unique index on a sampled table. */
const checkUniqueIndex = (lint: Lint, sample: AdvisorTableSample, index: AdvisorTable["indexes"][number]): Finding | undefined => {
    if (index.kind !== "index" || index.unique !== true) {
        return undefined;
    }

    const seen = new Map<string, string>(); // compositeKey → first rowId
    const duplicateIds: string[] = [];

    for (const row of sample.rows) {
        const id = rowId(row);
        const key = compositeKey(row, index.fields);

        if (key === undefined) {
            continue;
        }

        const existingId = seen.get(key);

        if (existingId === undefined) {
            seen.set(key, id);
        } else {
            recordDuplicate(id, existingId, duplicateIds);
        }
    }

    if (duplicateIds.length === 0) {
        return undefined;
    }

    const detail =
        `Table "${sample.table}": ${duplicateIds.length.toString()} sampled row(s) share duplicate values on unique index "${index.name}" ` +
        `(${index.fields.join(", ")}). Row ids: ${formatExamples(duplicateIds, duplicateIds.length)}` +
        `${truncatedSuffix(sample.truncated, sample.cap, "duplicates beyond the window may exist")}.`;

    return emit(lint, {
        cacheKey: `constraint_validator:unique:${sample.table}:${index.name}`,
        detail,
        metadata: {
            cap: sample.cap,
            count: duplicateIds.length,
            examples: duplicateIds.slice(0, MAX_EXAMPLE_IDS),
            fields: index.fields,
            index: index.name,
            kind: "unique",
            table: sample.table,
            truncated: sample.truncated,
        },
    });
};

// ── the lint ──────────────────────────────────────────────────────────────────

/** Check one sampled table against its schema entry and return all findings. */
const checkTable = (
    lint: Lint,
    sample: AdvisorTableSample,
    sampleByTable: Map<string, AdvisorTableSample>,
    tableByName: Map<string, AdvisorTable>,
): Finding[] => {
    const schemaTable = tableByName.get(sample.table);

    if (!schemaTable) {
        return [];
    }

    const findings: Finding[] = [];

    for (const relation of schemaTable.relations) {
        const targetSample = sampleByTable.get(relation.table);

        if (!targetSample) {
            continue;
        }

        const f = checkFkRelation(lint, sample, relation, targetSample);

        if (f) {
            findings.push(f);
        }
    }

    for (const field of schemaTable.fields) {
        // Skip optional/nullable fields — a null or absent value is valid for
        // them and must not produce a false-positive NOT NULL finding. When
        // `optionalFields` is absent (e.g. the codegen feeder path, which never
        // runs runtime lints), treat every field as required to preserve the
        // existing behaviour.
        const isRequired = !schemaTable.optionalFields?.has(field);
        const f = checkNullField(lint, sample, field, isRequired);

        if (f) {
            findings.push(f);
        }
    }

    for (const index of schemaTable.indexes) {
        const f = checkUniqueIndex(lint, sample, index);

        if (f) {
            findings.push(f);
        }
    }

    return findings;
};

/**
 * Constraint validator — flag rows that violate declared FK / NOT NULL / UNIQUE
 * constraints by cross-checking sampled row data against the schema.
 *
 * This lint reads the `context.tableSamples` feed (bounded row samples supplied
 * by the studio backend via `readTablePage`) and the declared schema. Three
 * families of check run over each sample:
 *
 * FK referential integrity: for every `one` relation the holding table declares,
 * check that each sampled row's FK column value appears in the target table's
 * sampled id set. A dangling value means no target row exists for the reference.
 *
 * NOT NULL / non-optional columns: the lint surfaces rows with null/undefined in
 * declared fields — inserted before a column was added or via raw import.
 *
 * UNIQUE index violations: for each declared unique secondary index, check the
 * sampled rows for duplicate values across the index's columns.
 *
 * All checks are bounded by the cap in each sample; the lint never triggers an
 * additional read. When a sample is truncated, findings note the caveat.
 */
const constraintValidator: Lint = {
    categories: ["SCHEMA"],
    description:
        "Sampled rows violate one or more declared constraints: a foreign-key column references a non-existent row, a non-optional column contains null, or a unique-indexed column has duplicate values. These violations indicate data inserted before a constraint was enforced (e.g. a schema migration, a raw import, or a bug in a past data-migration transform).",
    facing: "INTERNAL",
    level: "WARN",
    name: "constraint_validator",
    remediation:
        "Inspect the listed rows and correct or remove the violating values. Run a data migration to backfill nulls, dedup unique violations, or re-link dangling FK references. For FK violations, confirm the target table rows exist before fixing the referencing rows.",
    run: (context) => {
        if (!context.tableSamples || context.tableSamples.length === 0) {
            return [];
        }

        const sampleByTable = new Map<string, AdvisorTableSample>();

        for (const sample of context.tableSamples) {
            sampleByTable.set(sample.table, sample);
        }

        // Index the schema once, not once per sampled table — the lookup is hot
        // (every relation/field/index check resolves through it).
        const tableByName = new Map(context.schema.tables.map((table) => [table.name, table]));

        return context.tableSamples.flatMap((sample) => checkTable(constraintValidator, sample, sampleByTable, tableByName));
    },
    source: "runtime",
    title: "Constraint violation",
};

export default constraintValidator;
