/**
 * Merge an introspected database into an EXISTING `lunora/schema.ts`.
 *
 * The first run writes a whole schema module; every run after that lands on a
 * file the developer has since edited — renamed a column, tightened a validator,
 * added a relation. Clobbering it (or refusing without `--force`) makes
 * re-introspection useless exactly when it becomes useful: after the source
 * database gains a table.
 *
 * So a re-run plans additive edits instead and applies them through
 * `@lunora/config`'s `applyAdditiveEdit` — the same formatting-preserving,
 * ts-morph-backed path the visual schema editor uses. Two of its rules are
 * inherited deliberately rather than worked around. First, new columns land
 * `v.optional(...)`: a required column added to a table that already exists needs
 * a backfill, so the editor refuses to write one, and tightening it afterwards is
 * the developer's call. Second, names must be bare identifiers — an `order-items`
 * table is legal in Postgres and legal in the first-run emitter (which quotes it),
 * but the editor's allow-list rejects it, so such tables are reported and skipped
 * rather than half-applied.
 *
 * Nothing here is destructive: a column dropped from the source database is left
 * alone in the schema, because deleting it would drop live rows.
 */
import type { SchemaEdit, SchemaTable } from "@lunora/config";
import { applyAdditiveEdit, parseSchema } from "@lunora/config";

import type { IntrospectedDatabase, IntrospectedTable, SqlDialect } from "./model";
import { RESERVED_COLUMNS, validatorForColumn } from "./model";

/** Same rule `@lunora/config`'s editor enforces; checked here so we can report a useful reason. */
const IDENTIFIER = /^[A-Z_$][\w$]*$/i;

interface MergePlan {
    readonly edits: ReadonlyArray<SchemaEdit>;
    readonly warnings: ReadonlyArray<string>;
}

interface MergeResult {
    /** Number of edits successfully applied. */
    readonly applied: number;
    /** `undefined` when nothing changed. */
    readonly text?: string;
    readonly warnings: ReadonlyArray<string>;
}

/** Strip the `v.optional(...)` wrapper — `applyAdditiveEdit` re-adds it, and would otherwise double it. */
const innerValidator = (expression: string): string =>
    expression.startsWith("v.optional(") && expression.endsWith(")") ? expression.slice("v.optional(".length, -1) : expression;

/** Shared inputs for {@link planColumns}, kept in one object so the signature stays readable. */
interface ColumnPlanContext {
    readonly dialect: SqlDialect;
    /** Table names that will exist in the merged schema — used to demote dangling foreign keys. */
    readonly present: ReadonlySet<string>;
    readonly warnings: string[];
}

/** Additive column edits for one table: everything the source has that the schema doesn't. */
const planColumns = (table: IntrospectedTable, current: SchemaTable | undefined, context: ColumnPlanContext): SchemaEdit[] => {
    const edits: SchemaEdit[] = [];
    const existingColumns = new Set(current?.columns.map((column) => column.name));

    for (const column of table.columns) {
        if (RESERVED_COLUMNS.has(column.name) || existingColumns.has(column.name)) {
            continue;
        }

        if (!IDENTIFIER.test(column.name)) {
            context.warnings.push(`${table.name}.${column.name}: skipped — column names must be bare identifiers to merge.`);

            continue;
        }

        // An FK whose target isn't in the merged schema would emit an unresolvable
        // `v.id(...)`, so demote it exactly as the first-run emitter does.
        const dangling = column.references !== undefined && !context.present.has(column.references.table);
        const { expression } = validatorForColumn(dangling ? { ...column, references: undefined } : column, context.dialect);

        edits.push({ column: column.name, kind: "addOptionalColumn", table: table.name, validator: innerValidator(expression) });

        if (!column.nullable && current !== undefined) {
            context.warnings.push(
                `${table.name}.${column.name}: added as \`v.optional(...)\` — a required column on an existing table needs a backfill migration.`,
            );
        }
    }

    return edits;
};

/** Additive index edits for one table: every source index the schema doesn't already declare. */
const planIndexes = (table: IntrospectedTable, current: SchemaTable | undefined, warnings: string[]): SchemaEdit[] => {
    const edits: SchemaEdit[] = [];
    const existingIndexes = new Set(current?.indexes.map((index) => index.name));

    for (const index of table.indexes) {
        const columns = index.columns.filter((column) => !RESERVED_COLUMNS.has(column));

        if (existingIndexes.has(index.name) || columns.length === 0) {
            continue;
        }

        if (!IDENTIFIER.test(index.name) || !columns.every((column) => IDENTIFIER.test(column))) {
            warnings.push(`${table.name}: index \`${index.name}\` skipped — index and column names must be bare identifiers to merge.`);

            continue;
        }

        edits.push({ fields: columns, kind: "addIndex", name: index.name, table: table.name, ...(index.unique ? { unique: true } : {}) });
    }

    return edits;
};

/**
 * Plan the additive edits that bring `existing` up to date with `database`.
 * Pure — nothing is applied and no file is read here, so the planner is testable
 * on its own.
 */
const planMerge = (database: IntrospectedDatabase, existing: ReadonlyArray<SchemaTable>, dialect: SqlDialect): MergePlan => {
    const edits: SchemaEdit[] = [];
    const warnings: string[] = [];
    const byName = new Map(existing.map((table) => [table.name, table]));
    const present = new Set([...byName.keys(), ...database.tables.map((table) => table.name)]);

    for (const table of database.tables) {
        if (!IDENTIFIER.test(table.name)) {
            warnings.push(`${table.name}: skipped — merging into an existing schema needs a table name that is a bare identifier.`);

            continue;
        }

        const current = byName.get(table.name);

        if (current === undefined) {
            // The rows live in the source database, so a newly-discovered table is
            // `.global()` on the hyperdrive backend, matching the first-run emitter.
            edits.push({ global: { backend: "hyperdrive" }, kind: "addTable", table: table.name });
        }

        edits.push(...planColumns(table, current, { dialect, present, warnings }), ...planIndexes(table, current, warnings));
    }

    return { edits, warnings };
};

/**
 * Apply {@link planMerge}'s edits to a schema source string, in order. A single
 * edit that fails is reported and skipped rather than aborting the run — the
 * remaining tables are still worth landing.
 */
const mergeIntoSchema = (source: string, database: IntrospectedDatabase, dialect: SqlDialect): MergeResult => {
    const parsed = parseSchema(source);

    if (!parsed.ok) {
        return { applied: 0, warnings: [`lunora/schema.ts could not be parsed (${parsed.reason}) — leave it alone and merge by hand, or pass --force.`] };
    }

    const plan = planMerge(database, parsed.tables, dialect);
    const warnings = [...plan.warnings];
    let text = source;
    let applied = 0;

    for (const edit of plan.edits) {
        const result = applyAdditiveEdit(text, edit);

        if (result.ok) {
            text = result.text;
            applied += 1;
        } else {
            warnings.push(`${edit.table}: skipped one edit (${result.reason}).`);
        }
    }

    return { applied, warnings, ...(applied === 0 ? {} : { text }) };
};

export type { MergePlan, MergeResult };
export { innerValidator, mergeIntoSchema, planMerge };
