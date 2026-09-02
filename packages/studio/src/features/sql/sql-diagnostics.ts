/**
 * Pure lint rules for the SQL editor — the client half of plan 201.
 *
 * Two sources, both cheap enough to run on every keystroke pause. First, the
 * read-only gate imported from `shared/sql-readonly.ts` — the exact function
 * `@lunora/do`'s SQL console enforces with. Sharing it is the point: an editor
 * that green-lights a statement the server then refuses is worse than no lint at
 * all. Second, schema awareness from the `SqlSchema` the autocomplete already
 * assembles (table names always complete, columns only for probed tables).
 *
 * Deliberately conservative about what it flags, because a false positive in an
 * always-on linter trains the operator to ignore it. Only identifiers in `FROM`
 * / `JOIN` position are checked as tables — a bare `x.` qualifier is far more
 * often an alias than a table. Only QUALIFIED column references
 * (`alias.column`) are checked, and only when the resolved table's columns have
 * actually been probed; an unqualified `SELECT foo` across a join is genuinely
 * ambiguous without a real parser, so it is left alone. CTE names bound by a
 * `WITH` clause, subquery sources, and the reserved `__lunora_*` / `sqlite_*`
 * tables are never flagged.
 *
 * No SQL parser: the lexical reading (masking, CTE names, alias resolution)
 * comes from `sql-context.ts`, which the autocomplete shares, so offsets map
 * back to the operator's text exactly and both features agree on what a
 * qualifier means.
 */
import { splitStatements } from "../../../../../shared/sql-split-statements";
import type { SqlSchema } from "./sql-autocomplete";
import { sqlContextOf } from "./sql-context";

/** Where a diagnostic came from, so the UI can group and the tests can assert. */
type DiagnosticSource = "gate" | "plan" | "schema" | "syntax";

/** One editor diagnostic. `offset`/`length` index into the ORIGINAL draft text. */
interface SqlDiagnostic {
    /** Length of the underlined span; absent when the diagnostic is statement-wide. */
    readonly length?: number;
    readonly message: string;
    /** Zero-based index into the draft; absent when the diagnostic is statement-wide. */
    readonly offset?: number;
    readonly severity: "error" | "warning";
    readonly source: DiagnosticSource;
}

/** Table names Studio never lists but SQLite (or Lunora's reserved tables) legitimately own. */
const INTERNAL_TABLE = /^(?:__lunora|sqlite_)/iu;

/** A `FROM`/`JOIN` source: the keyword, then the table identifier (subqueries start with `(` and don't match). */
const FROM_SOURCE = /\b(?:from|join)\s+([a-z_][\w$]*)/giu;

/** A qualified column reference: `qualifier.column`. */
const QUALIFIED_COLUMN = /\b([a-z_][\w$]*)\.([a-z_][\w$]*)/giu;

/** SQL keywords that can legally follow `FROM`/`JOIN` and are not table names. */
const NOT_A_TABLE = new Set([
    "cross",
    "full",
    "group",
    "having",
    "inner",
    "join",
    "lateral",
    "left",
    "limit",
    "offset",
    "order",
    "right",
    "select",
    "union",
    "where",
    "window",
]);

/** Flag `FROM`/`JOIN` sources that are neither a known table, a CTE, nor an internal table. */
const unknownTableDiagnostics = (masked: string, known: Set<string>, ctes: Set<string>): SqlDiagnostic[] => {
    const diagnostics: SqlDiagnostic[] = [];

    for (const match of masked.matchAll(FROM_SOURCE)) {
        const name = match[1] ?? "";
        const lower = name.toLowerCase();

        if (!known.has(lower) && !ctes.has(lower) && !NOT_A_TABLE.has(lower) && !INTERNAL_TABLE.test(name)) {
            diagnostics.push({
                length: name.length,
                message: `unknown table \`${name}\``,
                // The capture starts after the keyword + whitespace the match consumed.
                offset: match.index + match[0].length - name.length,
                severity: "error",
                source: "schema",
            });
        }
    }

    return diagnostics;
};

/**
 * Flag `qualifier.column` references whose qualifier resolves to a known table
 * that has been probed, and whose column that table does not have. Unprobed
 * tables are skipped entirely — warning from absent knowledge is the one way
 * this linter could actively mislead.
 */
const unknownColumnDiagnostics = (masked: string, schema: SqlSchema, targets: Map<string, string>): SqlDiagnostic[] => {
    const diagnostics: SqlDiagnostic[] = [];
    // Column lists are keyed by the table's real name; match case-insensitively.
    const columnsByTable = new Map<string, Set<string>>();

    for (const [table, columns] of Object.entries(schema.columns)) {
        columnsByTable.set(table.toLowerCase(), new Set(columns.map((column) => column.toLowerCase())));
    }

    for (const match of masked.matchAll(QUALIFIED_COLUMN)) {
        const qualifier = (match[1] ?? "").toLowerCase();
        const column = match[2] ?? "";
        const table = targets.get(qualifier);
        const columns = table === undefined ? undefined : columnsByTable.get(table);

        if (columns !== undefined && !columns.has(column.toLowerCase())) {
            diagnostics.push({
                length: column.length,
                message: `\`${table ?? ""}\` has no column \`${column}\``,
                offset: match.index + match[0].length - column.length,
                severity: "error",
                source: "schema",
            });
        }
    }

    return diagnostics;
};

/**
 * Lint a draft against the read-only gate and the known schema. Returns an empty
 * list for an empty draft — a blank editor is the resting state, not a mistake.
 *
 * When the gate rejects, schema checks are skipped: the statement is already
 * refused, and piling "unknown table" onto "DELETE is not allowed" buries the
 * one diagnostic that matters.
 */
const lintDraft = (draft: string, schema: SqlSchema): SqlDiagnostic[] => {
    if (draft.trim() === "") {
        return [];
    }

    // Per STATEMENT, matching what Run does. Linting the whole draft flagged every
    // multi-statement script as "only a single statement may be run" while the
    // runner executed it happily — the exact warn/reject disagreement
    // `shared/sql-readonly.ts` says can never be allowed to appear.
    const statements = splitStatements(draft);
    const known = new Set(schema.tables.map((table) => table.toLowerCase()));
    const diagnostics: SqlDiagnostic[] = [];

    for (const statement of statements) {
        const { offset, rejection } = statement;

        if (rejection !== undefined) {
            if (rejection.code !== "SQL_EMPTY") {
                diagnostics.push({
                    length: rejection.length,
                    message: rejection.message,
                    // The gate's offset is statement-relative; shift it onto the draft.
                    offset: rejection.offset === undefined ? offset : offset + rejection.offset,
                    severity: "error",
                    source: "gate",
                });
            }

            continue;
        }

        const { ctes, masked, targets } = sqlContextOf(statement.sql, schema.tables);

        diagnostics.push(
            ...[...unknownTableDiagnostics(masked, known, ctes), ...unknownColumnDiagnostics(masked, schema, targets)].map((diagnostic) => {
                return {
                    ...diagnostic,
                    offset: diagnostic.offset === undefined ? offset : offset + diagnostic.offset,
                };
            }),
        );
    }

    return diagnostics;
};

export { lintDraft };
export type { DiagnosticSource, SqlDiagnostic };
