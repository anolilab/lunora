import { LunoraError } from "@lunora/errors";

import type { SqlExec } from "./ctx-db";

/**
 * Result of a `__lunora_admin__:runSql` read-only query: the column names (from
 * the first row), the rows (capped), the total row count the query produced, and
 * whether the rows were truncated to the cap.
 */
interface SqlConsoleResult {
    columns: string[];
    rowCount: number;
    rows: Record<string, unknown>[];
    truncated: boolean;
}

/** Most rows the SQL console returns in one query, so a `SELECT *` on a huge table can't blow up the response. */
const MAX_SQL_ROWS = 1000;

/**
 * A statement is only allowed when it *leads* with a read verb. `EXPLAIN` /
 * `EXPLAIN QUERY PLAN` prefixes are permitted (they describe, never mutate).
 */
const READONLY_LEAD = /^(?:explain\s+(?:query\s+plan\s+)?)?(?:select|with)\b/iu;

/**
 * Mutating / schema / side-effecting verbs that must not appear ANYWHERE in the
 * statement. This is deliberately broad (defense-in-depth): a `WITH` CTE can
 * front a `DELETE`, and `EXPLAIN` can describe a write, so leading-verb checks
 * alone aren't enough. A benign query that merely mentions one of these words in
 * a string literal is rejected too — an acceptable trade for an admin tool that
 * must never corrupt the doc-store's FTS / aggregate / rank shadow tables.
 */
const FORBIDDEN_KEYWORD = /\b(?:alter|attach|create|delete|detach|drop|insert|pragma|reindex|replace|truncate|update|vacuum)\b/iu;

/** A single trailing semicolon (allowed); any other `;` marks a multi-statement batch. */
const TRAILING_SEMICOLON = /;\s*$/u;

/** Unicode whitespace, tested one code point at a time (no backtracking). */
const WHITESPACE = /\s/u;

/** Index just past a `-- …` line comment at `from` (skips to the newline, left as whitespace). */
const skipLineComment = (sql: string, from: number): number => {
    let index = from + 2;

    while (index < sql.length && sql[index] !== "\n") {
        index += 1;
    }

    return index;
};

/** Index just past a block comment at `from`, or `-1` when it never closes. */
const skipBlockComment = (sql: string, from: number): number => {
    const close = sql.indexOf("*/", from + 2);

    return close === -1 ? -1 : close + 2;
};

/**
 * Strip leading whitespace and SQL comments so the read-verb check sees the real
 * first token. A single linear scan rather than one alternation regex: an
 * alternation over whitespace, line comments, and block comments backtracks
 * polynomially against admin-supplied SQL on long runs of unterminated
 * block-comment openers. An unterminated block comment is left in place so the
 * read-verb check rejects it.
 */
const stripLeading = (sql: string): string => {
    let index = 0;

    while (index < sql.length) {
        const char = sql[index];

        if (char !== undefined && WHITESPACE.test(char)) {
            index += 1;
        } else if (char === "-" && sql[index + 1] === "-") {
            index = skipLineComment(sql, index);
        } else if (char === "/" && sql[index + 1] === "*") {
            const next = skipBlockComment(sql, index);

            if (next === -1) {
                break;
            }

            index = next;
        } else {
            break;
        }
    }

    return sql.slice(index);
};

/** Build a tagged LunoraError the runtime serializes with its `status`. */
const sqlError = (message: string, code: string): Error => new LunoraError(code, message, { status: 400 });

/**
 * Reject anything that isn't a single read-only statement. Throws a 400
 * LunoraError the studio surfaces inline. Enforces: non-empty, a single
 * statement (no `;`-separated batch), a leading `SELECT`/`WITH`/`EXPLAIN`, and no
 * mutating/DDL keyword anywhere.
 */
const assertReadonly = (query: string): void => {
    const trimmed = stripLeading(query).trim();

    if (trimmed === "") {
        throw sqlError("the query is empty", "SQL_EMPTY");
    }

    // Allow a single trailing semicolon; any other `;` means a multi-statement batch.
    const single = trimmed.replace(TRAILING_SEMICOLON, "");

    if (single.includes(";")) {
        throw sqlError("only a single statement may be run", "SQL_MULTIPLE_STATEMENTS");
    }

    if (!READONLY_LEAD.test(single) || FORBIDDEN_KEYWORD.test(single)) {
        throw sqlError("the SQL editor is read-only — only SELECT / WITH / EXPLAIN queries are allowed", "SQL_NOT_READONLY");
    }
};

/**
 * Run a **read-only** SQL query against the shard's SQLite and shape the result
 * for the studio's SQL editor. The server half of a Supabase/Outerbase-style SQL
 * console: it executes the verbatim query (so power users can `json_extract` the
 * `__doc__` blob, join, aggregate, `EXPLAIN`, …) but {@link assertReadonly}
 * rejects every mutating statement, because raw writes would bypass the
 * schema-aware writer and desync the FTS / aggregate / rank shadow tables.
 * Admin-gated by `ShardDO.handleAdminRpc` like every other introspection RPC.
 *
 * Rows are capped at {@link MAX_SQL_ROWS}; `rowCount` reports the true total and
 * `truncated` flags when more rows existed than were returned.
 */
const runReadonlySql = (sql: SqlExec, query: string): SqlConsoleResult => {
    assertReadonly(query);

    const all = sql.exec(query).toArray();
    const rows = all.length > MAX_SQL_ROWS ? all.slice(0, MAX_SQL_ROWS) : all;
    const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];

    return { columns, rowCount: all.length, rows, truncated: all.length > MAX_SQL_ROWS };
};

export { assertReadonly, MAX_SQL_ROWS, runReadonlySql };
export type { SqlConsoleResult };
