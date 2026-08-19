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
 * The comment scanner below is a near-twin of the one in the studio's
 * `features/sql/sql-context.ts`, and that duplication is deliberate: this file is
 * inlined into `@lunora/do`, which must stay free of studio feature modules, and
 * `shared/` may only import other zero-dependency `shared/` files. If a third
 * consumer appears, promote the scanner to its own `shared/` module rather than
 * pointing this one at the studio.
 */

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

/** The statement's first word, used to point the "not read-only" diagnostic somewhere useful. */
const LEADING_WORD = /^\w+/u;

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

/** Filler for masked content. A letter, so it can never look like a `;`, a quote, or a comment opener. */
const MASK_CHAR = "x";

/** Closing delimiter per quote opener. SQLite doubles the delimiter to escape it, except for `[...]`. */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "[": "]", "`": "`" };

/**
 * A same-length copy of `sql` with the CONTENT of string literals, quoted
 * identifiers and comments replaced by {@link MASK_CHAR}, or `undefined` when a
 * quote or block comment never closes.
 *
 * Only the batch check reads this, and only to answer "is this `;` a statement
 * boundary". A `;` inside `'…'`, `"…"`, `` `…` ``, `[…]`, `-- …` or `/* … *\/` is
 * content, not a boundary — SQLite's own parser never sees a second statement
 * there — so scanning the raw text reported four separate false batches
 * (`SELECT ';' AS a`, `SELECT 1 -- a; b`, `SELECT 1 /* a; b *\/`,
 * `SELECT "a;b" FROM t`), each of which is a legal read-only query the console
 * refused to run at all.
 *
 * It is deliberately NOT used for {@link FORBIDDEN_KEYWORD}. That check rejects a
 * mutating word even inside a literal, and its docblock records that as an
 * accepted trade for an admin tool that must never corrupt the doc-store's
 * shadow tables. Masking there would relax a rule someone chose; masking here
 * fixes one nobody did.
 *
 * **Fail-closed on anything unclosed.** An unterminated quote or block comment
 * returns `undefined`, and the caller falls back to scanning the raw text — the
 * behaviour that shipped. Such a statement is a syntax error to SQLite anyway,
 * so the strictness costs nothing and the alternative (masking to end of input)
 * would hide a real `;` behind a stray quote.
 *
 * Length is preserved so a rejection's `offset` still indexes the caller's own
 * string. Newlines survive for the same reason.
 */
const maskNonCode = (sql: string): string | undefined => {
    const out = [...sql];
    let index = 0;

    while (index < sql.length) {
        const char = sql[index] ?? "";
        const closer = QUOTE_CLOSERS[char];

        if (char === "-" && sql[index + 1] === "-") {
            const end = skipLineComment(sql, index);

            out.fill(MASK_CHAR, index, end);
            index = end;
        } else if (char === "/" && sql[index + 1] === "*") {
            const end = skipBlockComment(sql, index);

            if (end === -1) {
                return undefined;
            }

            out.fill(MASK_CHAR, index, end);
            index = end;
        } else if (closer !== undefined) {
            let scan = index + 1;

            while (scan < sql.length) {
                if (sql[scan] !== closer) {
                    scan += 1;
                } else if (closer !== "]" && sql[scan + 1] === closer) {
                    // A doubled delimiter escapes it — `''`, `""`, ` `` ` — and is
                    // content, so step over both. `[...]` has no escape form.
                    scan += 2;
                } else {
                    break;
                }
            }

            if (scan >= sql.length) {
                return undefined;
            }

            out.fill(MASK_CHAR, index, scan + 1);
            index = scan + 1;
        } else {
            index += 1;
        }
    }

    // Newlines are restored so line geometry — and therefore any offset an editor
    // derives from it — is unchanged.
    for (const [at, original] of [...sql].entries()) {
        if (original === "\n") {
            out[at] = "\n";
        }
    }

    return out.join("");
};

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
    // Located on a comment/quote-MASKED copy (same length, so the offset still
    // indexes `query`), because a `;` inside a literal or a comment is content
    // rather than a boundary. Anything unclosed masks to `undefined` and falls
    // back to the raw scan — see {@link maskNonCode}.
    const single = trimmed.replace(TRAILING_SEMICOLON, "");
    const batchAt = (maskNonCode(single) ?? single).indexOf(";");

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

export { classifyStatement };
export type { SqlRejection, SqlRejectionCode };
