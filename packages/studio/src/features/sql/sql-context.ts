/**
 * The one lexical read of a SQL draft: where the comments and string literals
 * are, which tables the statement selects from, and what each qualifier
 * (`m.`, `messages.`) resolves to.
 *
 * Extracted because the editor grew two incompatible answers to the same
 * question. `sql-autocomplete.ts` resolved a `tbl.` qualifier by reading the
 * word behind the caret, which cannot see aliases at all — typing
 * `SELECT m.| FROM messages m` completed nothing. `sql-diagnostics.ts` then
 * needed real alias resolution to check qualified columns and built a second,
 * better one. Two modules in one directory disagreeing about what `m.` means is
 * the kind of split that produces "the linter says the column is wrong but
 * autocomplete won't offer the right one". Now both read from here, so the
 * autocomplete gains alias awareness for free and there is one place to fix when
 * someone writes `FROM a, b`.
 *
 * Deliberately NOT a parser: everything works off a literal/comment-masked copy
 * of the text, so offsets map back to the operator's draft exactly. See
 * `sql-diagnostics.ts` for the conservatism rules this enables.
 */

/** A `FROM`/`JOIN` source plus an optional alias (`AS x` or bare `x`). */
const SOURCE_WITH_ALIAS = /\b(?:from|join)\s+([a-z_][\w$]*)(?:\s+(?:as\s+)?([a-z_][\w$]*))?/giu;

/** A CTE name bound by `WITH name AS (` / `, name AS (`. */
const CTE_BINDING = /(?:\bwith\s+(?:recursive\s+)?|,\s*)([a-z_][\w$]*)\s+as\s*\(/giu;

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
 * ordinary code. One decision per construct, so the scanner stays readable.
 */
const nonCodeRunEnd = (sql: string, from: number): number => {
    const char = sql[from];

    // Only SINGLE quotes delimit a string literal in SQL. Double quotes delimit
    // an IDENTIFIER — masking `FROM "users"` as if it were data left the scanner
    // seeing `FROM` followed by the next keyword, so the linter reported
    // `unknown table \`WHERE\`` on a valid statement and the autocomplete bound
    // no alias for it.
    if (char === "'") {
        let end = from + 1;

        while (end < sql.length && sql[end] !== "'") {
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
 * literal or a commented-out `DELETE` would be read as live code.
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

/** Every name bound by a `WITH` clause, lowercased — valid sources, but not real tables. */
const cteNames = (masked: string): Set<string> => {
    const names = new Set<string>();

    for (const match of masked.matchAll(CTE_BINDING)) {
        names.add((match[1] ?? "").toLowerCase());
    }

    return names;
};

/**
 * Map every qualifier that can stand for a table — the table's own name, plus
 * any alias bound in a `FROM`/`JOIN` — to the table it resolves to. Both sides
 * lowercased, because SQL identifiers are matched case-insensitively here.
 *
 * `known` gates which sources count, so a CTE or a typo'd table never binds an
 * alias that would then be used to "check" columns against nothing.
 */
const qualifierTargets = (masked: string, known: ReadonlySet<string>): Map<string, string> => {
    const targets = new Map<string, string>();

    for (const match of masked.matchAll(SOURCE_WITH_ALIAS)) {
        const table = (match[1] ?? "").toLowerCase();
        const alias = (match[2] ?? "").toLowerCase();

        if (known.has(table)) {
            targets.set(table, table);

            if (alias !== "" && !NOT_AN_ALIAS.has(alias)) {
                targets.set(alias, table);
            }
        }
    }

    return targets;
};

/** The lexical facts about one draft, computed once and shared by both consumers. */
interface SqlContext {
    /** CTE names bound by a `WITH` clause. */
    readonly ctes: Set<string>;
    /** The draft with comments and string literals blanked, offsets preserved. */
    readonly masked: string;
    /** Qualifier (table name or alias) → the table it resolves to. */
    readonly targets: Map<string, string>;
}

/** Read a draft's lexical context against the set of known table names. */
const sqlContextOf = (draft: string, tables: ReadonlyArray<string>): SqlContext => {
    const masked = maskNonCode(draft);
    const known = new Set(tables.map((table) => table.toLowerCase()));

    return { ctes: cteNames(masked), masked, targets: qualifierTargets(masked, known) };
};

export { maskNonCode, sqlContextOf };
export type { SqlContext };
