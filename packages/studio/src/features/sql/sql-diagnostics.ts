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
 * No SQL parser: everything works off a literal/comment-masked copy of the
 * statement, so offsets map back to the operator's text exactly.
 */
import { classifyStatement } from "../../../../../shared/sql-readonly";
import type { SqlSchema } from "./sql-autocomplete";

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

/** A `FROM`/`JOIN` source plus an optional alias (`AS x` or bare `x`), used to resolve qualifiers. */
const SOURCE_WITH_ALIAS = /\b(?:from|join)\s+([a-z_][\w$]*)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/giu;

/** A CTE name bound by `WITH name AS (` / `, name AS (`. */
const CTE_BINDING = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][\w$]*)\s+as\s*\(/giu;

/** A qualified column reference: `qualifier.column`. */
const QUALIFIED_COLUMN = /\b([a-z_][\w$]*)\.([a-z_][\w$]*)/giu;

/** SQL keywords that can legally follow `FROM`/`JOIN` and are not table names. */
const NOT_A_TABLE = new Set(["lateral", "select"]);

/** Keywords that can appear where an alias would, and must not be read as one. */
const NOT_AN_ALIAS = new Set([
    "cross",
    "full",
    "group",
    "having",
    "inner",
    "join",
    "left",
    "limit",
    "offset",
    "on",
    "order",
    "right",
    "union",
    "using",
    "where",
    "window",
]);

/** Every character except a newline — newlines survive masking so line geometry is unchanged. */
const NON_NEWLINE = /[^\n]/gu;

/**
 * The end index of the non-code run starting at `from`, or `-1` when `from` is
 * ordinary code. Split out of {@link maskNonCode} so the scanner is one small
 * decision per construct rather than one deeply-nested loop.
 */
const nonCodeRunEnd = (sql: string, from: number): number => {
    const char = sql[from];

    if (char === "'" || char === '"') {
        let end = from + 1;

        while (end < sql.length && sql[end] !== char) {
            end += 1;
        }

        // +1 to include the closing quote; an unterminated literal runs to the end.
        return Math.min(end + 1, sql.length);
    }

    if (char === "-" && sql[from + 1] === "-") {
        const newline = sql.indexOf("\n", from);

        return newline === -1 ? sql.length : newline;
    }

    if (char === "/" && sql[from + 1] === "*") {
        const close = sql.indexOf("*/", from + 2);

        return close === -1 ? sql.length : close + 2;
    }

    return -1;
};

/**
 * Blank out string literals and comments, preserving length so every offset
 * still lines up with the original text. Without this, a `'-- not a comment'`
 * literal or a commented-out `DELETE` would be linted as live code.
 */
const maskNonCode = (sql: string): string => {
    let out = "";
    let index = 0;

    while (index < sql.length) {
        const end = nonCodeRunEnd(sql, index);

        if (end === -1) {
            out += sql.slice(index, index + 1);
            index += 1;
        } else {
            out += sql.slice(index, end).replaceAll(NON_NEWLINE, " ");
            index = end;
        }
    }

    return out;
};

/** Every name bound by a `WITH` clause, lowercased — these are valid sources but not real tables. */
const cteNames = (masked: string): Set<string> => {
    const names = new Set<string>();

    CTE_BINDING.lastIndex = 0;
    let match = CTE_BINDING.exec(masked);

    while (match !== null) {
        names.add((match[1] ?? "").toLowerCase());
        match = CTE_BINDING.exec(masked);
    }

    return names;
};

/**
 * Map every qualifier that can stand for a table — the table's own name, plus
 * any alias bound in a `FROM`/`JOIN` — to the table it resolves to. Lowercased
 * on both sides, because SQL identifiers are matched case-insensitively here.
 */
const qualifierTargets = (masked: string, known: Set<string>): Map<string, string> => {
    const targets = new Map<string, string>();

    SOURCE_WITH_ALIAS.lastIndex = 0;
    let match = SOURCE_WITH_ALIAS.exec(masked);

    while (match !== null) {
        const table = (match[1] ?? "").toLowerCase();
        const alias = (match[2] ?? "").toLowerCase();

        if (known.has(table)) {
            targets.set(table, table);

            if (alias !== "" && !NOT_AN_ALIAS.has(alias)) {
                targets.set(alias, table);
            }
        }

        match = SOURCE_WITH_ALIAS.exec(masked);
    }

    return targets;
};

/** Flag `FROM`/`JOIN` sources that are neither a known table, a CTE, nor an internal table. */
const unknownTableDiagnostics = (masked: string, known: Set<string>, ctes: Set<string>): SqlDiagnostic[] => {
    const diagnostics: SqlDiagnostic[] = [];

    FROM_SOURCE.lastIndex = 0;
    let match = FROM_SOURCE.exec(masked);

    while (match !== null) {
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

        match = FROM_SOURCE.exec(masked);
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

    QUALIFIED_COLUMN.lastIndex = 0;
    let match = QUALIFIED_COLUMN.exec(masked);

    while (match !== null) {
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

        match = QUALIFIED_COLUMN.exec(masked);
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

    const rejection = classifyStatement(draft);

    if (rejection !== undefined) {
        if (rejection.code === "SQL_EMPTY") {
            return [];
        }

        return [{ length: rejection.length, message: rejection.message, offset: rejection.offset, severity: "error", source: "gate" }];
    }

    const masked = maskNonCode(draft);
    const known = new Set(schema.tables.map((table) => table.toLowerCase()));
    const ctes = cteNames(masked);

    return [...unknownTableDiagnostics(masked, known, ctes), ...unknownColumnDiagnostics(masked, schema, qualifierTargets(masked, known))];
};

export { lintDraft, maskNonCode };
export type { DiagnosticSource, SqlDiagnostic };
