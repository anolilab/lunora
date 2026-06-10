/** SQL keywords upper-cased by {@link formatSql}; longest-first so multi-word clauses match before their prefix. */
const SQL_KEYWORDS: ReadonlyArray<string> = [
    "ORDER BY",
    "GROUP BY",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "OUTER JOIN",
    "CROSS JOIN",
    "EXPLAIN QUERY PLAN",
    "SELECT",
    "DISTINCT",
    "FROM",
    "WHERE",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "JOIN",
    "ON",
    "AND",
    "OR",
    "AS",
    "ASC",
    "DESC",
    "WITH",
    "UNION",
    "EXPLAIN",
];

/** Clauses that begin a new line in the formatted output. */
const SQL_NEWLINE_CLAUSES: ReadonlyArray<string> = [
    "FROM",
    "WHERE",
    "ORDER BY",
    "GROUP BY",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "OUTER JOIN",
    "CROSS JOIN",
];

/**
 * A sentinel that brackets stashed string literals while {@link formatSql}
 * rewrites keywords/whitespace. NUL can't appear in user-typed SQL, so it never
 * collides with a real token (e.g. a numeric literal like `5`).
 */
const SENTINEL = String.fromCodePoint(0);
/** Matches a stashed-literal placeholder (NUL-index-NUL) on restore. */
const RESTORE_RE = new RegExp(`${SENTINEL}${String.raw`(\d+)`}${SENTINEL}`, "gu");

/**
 * A small, pragmatic SQL pretty-printer for the read-only SELECT / WITH / EXPLAIN
 * the editor allows. It upper-cases known keywords (whole-word, case-insensitive),
 * collapses runs of whitespace, and breaks a new line before each major clause. It
 * is intentionally not a full SQL parser — string literals are preserved verbatim
 * and only reasonable read queries are expected. Idempotent: formatting an already
 * formatted query yields the same string.
 */
const formatSql = (sql: string): string => {
    // Preserve single-quoted string literals (incl. '' escapes) by stashing them
    // behind NUL-delimited placeholders so keyword/whitespace rewriting never
    // touches their contents.
    const literals: string[] = [];
    const withPlaceholders = sql.replaceAll(/'(?:[^']|'')*'/gu, (match) => {
        literals.push(match);

        return `${SENTINEL}${(literals.length - 1).toString()}${SENTINEL}`;
    });

    // Collapse all whitespace (including newlines) to single spaces, then trim.
    let out = withPlaceholders.replaceAll(/\s+/gu, " ").trim();

    // Upper-case keywords as whole words (longest-first via the source ordering).
    for (const keyword of SQL_KEYWORDS) {
        const pattern = new RegExp(String.raw`\b${keyword.replaceAll(" ", String.raw`\s+`)}\b`, "giu");

        out = out.replaceAll(pattern, keyword);
    }

    // Break a new line before each major clause (but not at the very start).
    for (const clause of SQL_NEWLINE_CLAUSES) {
        const pattern = new RegExp(String.raw`\s+${clause.replaceAll(" ", String.raw`\s+`)}\b`, "gu");

        out = out.replaceAll(pattern, `\n${clause}`);
    }

    // Restore the stashed string literals.
    out = out.replaceAll(RESTORE_RE, (_match, index: string) => literals[Number(index)] ?? "");

    return out;
};

export default formatSql;
