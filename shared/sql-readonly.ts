/**
 * Canonical read-only SQL gate shared by `@lunora/do` and `@lunora/studio`.
 *
 * `@lunora/do`'s SQL console (`sql-console.ts`) uses this as its **enforcement**:
 * a statement that fails `classifyStatement` never reaches SQLite, because raw
 * writes would bypass the schema-aware writer and desync the doc-store's FTS /
 * aggregate / rank shadow tables. `@lunora/studio`'s SQL editor uses the exact
 * same function as a **lint**, so the warning it shows while you type and the
 * rejection you get on Run can never disagree. Two copies of this rule would
 * drift, and the drift would read as a Studio bug.
 *
 * Like `shared/quote-identifier.ts`, it is deliberately **not** a package: the
 * DO and the browser bundle sit on different tiers with no shared lower-level
 * package to host it, so each imports this file by relative path and the bundler
 * inlines it — no runtime dependency edge. Keep it genuinely zero-dependency
 * (relative/built-in imports only) or inlining breaks. Consumers must drop
 * `outDir`/`rootDir` from their `tsconfig.json` (a set `rootDir` raises TS6059
 * for this out-of-package file under `tsc --noEmit`).
 *
 * The classifier returns a rejection *value* rather than throwing, because the
 * browser half needs an offset to underline and the server half needs an error
 * code to serialize. Callers add their own error type.
 *
 * The boundary scanner it uses lives in `shared/sql-mask.ts`, along with the
 * line- and block-comment skippers this file's leading-token scan shares with it
 * — promoted out of
 * this file when a third consumer (the Studio's statement splitter) appeared,
 * exactly as the note that used to sit here instructed. It stays separate from
 * the studio's own `maskNonCode` in `features/sql/sql-context.ts`, which
 * deliberately treats `"…"` as code because it resolves identifiers rather than
 * finding statement boundaries.
 */

import { maskSqlNonCode, skipBlockComment, skipLineComment } from "./sql-mask";

/** Why a statement was rejected. Mirrors the codes the DO serializes to the client. */
type SqlRejectionCode = "SQL_EMPTY" | "SQL_MULTIPLE_STATEMENTS" | "SQL_NOT_READONLY";

/**
 * A refused statement: a stable code, an operator-facing message, and — when the
 * offending text can be located — its span in the ORIGINAL query string (not the
 * comment-stripped one), so an editor can underline exactly the token at fault.
 */
interface SqlRejection {
    readonly code: SqlRejectionCode;
    /** Length of the offending span, when `offset` is set. */
    readonly length?: number;
    readonly message: string;
    /** Zero-based index into the original query string, when locatable. */
    readonly offset?: number;
}

/**
 * A statement is only allowed when it *leads* with a read verb. `EXPLAIN` /
 * `EXPLAIN QUERY PLAN` prefixes are permitted (they describe, never mutate).
 *
 * A bare `VALUES (1), (2)` — a read-only row constructor in SQLite — is refused
 * by this list rather than overlooked by it. The rule the diagnostic states is
 * exactly the rule enforced ("only SELECT / WITH / EXPLAIN"), and an operator
 * who wants those rows types `SELECT 1 UNION ALL SELECT 2`. Widening the lead
 * set buys nothing and adds a verb the CTE scan below would then have to reason
 * about.
 */
const READONLY_LEAD = /^(?:explain\s+(?:query\s+plan\s+)?)?(?:select|with)\b/iu;

/**
 * Mutating / schema / side-effecting verbs that must not appear ANYWHERE in the
 * statement. This is deliberately broad (defense-in-depth): a `WITH` CTE can
 * front a `DELETE`, and `EXPLAIN` can describe a write, so leading-verb checks
 * alone aren't enough. A benign query that merely mentions one of these words in
 * a string literal is rejected too — an acceptable trade for an admin tool that
 * must never corrupt the doc-store's FTS / aggregate / rank shadow tables.
 *
 * `replace` is the one word on this list that is ALSO a core read-only scalar
 * (`replace(x, 'a', 'b')`), so it gets its own arm: a bare `\breplace\b` refused
 * an ordinary `SELECT replace(...)` with a message naming a rule the operator
 * had not broken. The negative lookahead is the whole discrimination — the write
 * form is `REPLACE INTO`, never `REPLACE (`. It is deliberately the lookahead
 * and not a `replace\s+into` match, so an inline block comment wedged between
 * the two words — whitespace to SQLite's tokenizer, but not to `\s` — still
 * fails the scan. The residual false refusal (a comment between `replace` and
 * its own paren) errs toward refusing, and nobody writes it.
 */
const FORBIDDEN_KEYWORD = /\b(?:alter|attach|create|delete|detach|drop|insert|pragma|reindex|truncate|update|vacuum)\b|\breplace\b(?!\s*\()/iu;

/** The statement's first word, used to point the "not read-only" diagnostic somewhere useful. */
const LEADING_WORD = /^\w+/u;

/** A single trailing semicolon (allowed); any other `;` marks a multi-statement batch. */
const TRAILING_SEMICOLON = /;\s*$/u;

/** Unicode whitespace, tested one code point at a time (no backtracking). */
const WHITESPACE = /\s/u;

/**
 * Index of the first character that is neither whitespace nor a SQL comment, so
 * the read-verb check sees the real first token. A single linear scan rather
 * than one alternation regex: an alternation over whitespace, line comments, and
 * block comments backtracks polynomially against admin-supplied SQL on long runs
 * of unterminated block-comment openers. An unterminated block comment stops the
 * scan where it opened, so the read-verb check rejects it.
 *
 * Returning the index (rather than a slice) is what lets rejections carry an
 * offset into the caller's original string.
 */
const leadingNoiseEnd = (sql: string): number => {
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

    return index;
};

/**
 * Classify a statement against the read-only rules. Returns `undefined` when the
 * statement is allowed, or a {@link SqlRejection} describing the first violation.
 *
 * Enforces, in order: non-empty, a single statement (no `;`-separated batch), a
 * leading `SELECT`/`WITH`/`EXPLAIN`, and no mutating/DDL keyword anywhere. The
 * ordering is part of the contract — an empty query and a batch have their own
 * codes, everything else collapses into `SQL_NOT_READONLY`.
 */
const classifyStatement = (query: string): SqlRejection | undefined => {
    const start = leadingNoiseEnd(query);
    // `trimEnd` only — `leadingNoiseEnd` already consumed the leading run, so
    // every offset below is `start`-relative and maps back to `query` by addition.
    const trimmed = query.slice(start).trimEnd();

    if (trimmed === "") {
        return { code: "SQL_EMPTY", message: "the query is empty" };
    }

    // Allow a single trailing semicolon; any other `;` means a multi-statement batch.
    // Both the strip and the search run on a comment/quote-MASKED copy (same
    // length, so the offset still indexes `query`), because a `;` inside a literal
    // or a comment is content rather than a boundary — and because a COMMENT after
    // the trailing `;` is a trailing comment, not a second statement. Comments mask
    // to whitespace, so `SELECT 1; -- note` still reads as one trailing semicolon;
    // stripping it off the raw text instead refused that draft as a batch.
    // Anything unclosed masks to `undefined` and falls back to the raw scan — see
    // {@link maskSqlNonCode}.
    const masked = maskSqlNonCode(trimmed) ?? trimmed;
    const maskedSingle = masked.replace(TRAILING_SEMICOLON, "");
    const single = trimmed.slice(0, maskedSingle.length);
    const batchAt = maskedSingle.indexOf(";");

    if (batchAt !== -1) {
        return {
            code: "SQL_MULTIPLE_STATEMENTS",
            length: 1,
            message: "only a single statement may be run",
            offset: start + batchAt,
        };
    }

    const notReadonly = "the SQL editor is read-only — only SELECT / WITH / EXPLAIN queries are allowed";

    if (!READONLY_LEAD.test(single)) {
        const lead = LEADING_WORD.exec(single);

        return {
            code: "SQL_NOT_READONLY",
            length: lead?.[0].length ?? 1,
            message: notReadonly,
            offset: start,
        };
    }

    const forbidden = FORBIDDEN_KEYWORD.exec(single);

    if (forbidden !== null) {
        return {
            code: "SQL_NOT_READONLY",
            length: forbidden[0].length,
            message: `${notReadonly} (\`${forbidden[0].toUpperCase()}\` is not allowed)`,
            offset: start + forbidden.index,
        };
    }

    return undefined;
};

/** A statement that already leads with `EXPLAIN` (optionally `EXPLAIN QUERY PLAN`). */
const EXPLAIN_LEAD = /^explain\b/iu;

/**
 * Wrap `query` in `EXPLAIN QUERY PLAN` — unless it already leads with `EXPLAIN`.
 *
 * {@link READONLY_LEAD} deliberately admits an `EXPLAIN [QUERY PLAN]` prefix, so
 * an operator can type one; prefixing another produces
 * `EXPLAIN QUERY PLAN EXPLAIN …`, which SQLite refuses with
 * `near "EXPLAIN": syntax error`. Both the server lint and the studio's Explain
 * tab wrap, so both went red on a draft that Run executed happily — the exact
 * warn/reject disagreement this file exists to prevent.
 *
 * Leading whitespace and comments are skipped the same way {@link
 * classifyStatement} skips them, so a commented-out preamble does not hide the
 * `EXPLAIN`.
 * @returns the query itself when it already explains, else the wrapped form
 */
const explainQueryPlan = (query: string): string => (EXPLAIN_LEAD.test(query.slice(leadingNoiseEnd(query))) ? query : `EXPLAIN QUERY PLAN ${query}`);

export { classifyStatement, explainQueryPlan };
export type { SqlRejection, SqlRejectionCode };
