/**
 * The canonical "where is this character actually code?" scanner for SQL, shared
 * by the read-only gate (`shared/sql-readonly.ts`) and the Studio's statement
 * splitter (`@lunora/studio`'s `split-statements.ts`).
 *
 * Its one job is BOUNDARY DETECTION: deciding whether a given `;` starts a new
 * statement or is content inside a literal, a quoted identifier, or a comment.
 * Both consumers must answer that identically — the gate refuses a statement the
 * splitter produced, so a splitter using a laxer mask hands the gate a torn
 * statement, and one using a stricter mask hides a real batch.
 *
 * **Not to be confused with the Studio's own `maskNonCode`** in
 * `features/sql/sql-context.ts`. That one deliberately leaves `"…"` as CODE,
 * because it resolves table aliases and masking `FROM "users"` left its scanner
 * seeing `FROM` followed by the next keyword. Identifier resolution and boundary
 * detection are genuinely different questions and their masks are allowed to
 * differ; what is not allowed is a boundary detector borrowing the identifier
 * resolver's mask, which is exactly the bug this module exists to prevent.
 *
 * Its own `shared/` module rather than an export of `sql-readonly.ts`, per that
 * file's standing instruction: a scanner with a third consumer gets promoted
 * instead of being reached into. Keep it genuinely zero-dependency (relative or
 * built-in imports only) or the bundler inlining that lets `@lunora/do` and
 * `@lunora/studio` share it without a dependency edge stops working.
 */

/** Filler for masked content. A letter, so it can never look like a `;`, a quote, or a comment opener. */
const MASK_CHAR = "x";

/** Closing delimiter per quote opener. SQLite doubles the delimiter to escape it, except for `[...]`. */
const QUOTE_CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "[": "]", "`": "`" };

/** Index just past a `-- …` line comment at `from` (the newline itself is left alone). */
export const skipLineComment = (sql: string, from: number): number => {
    let index = from + 2;

    while (index < sql.length && sql[index] !== "\n") {
        index += 1;
    }

    return index;
};

/** Index just past a block comment at `from`, or `-1` when it never closes. */
export const skipBlockComment = (sql: string, from: number): number => {
    const close = sql.indexOf("*/", from + 2);

    return close === -1 ? -1 : close + 2;
};

/**
 * A same-length copy of `sql` with the CONTENT of string literals, quoted
 * identifiers and comments replaced by {@link MASK_CHAR}, or `undefined` when a
 * quote or block comment never closes.
 *
 * A `;` inside `'…'`, `"…"`, `` `…` ``, `[…]`, `-- …` or a block comment is
 * content, not a statement boundary — SQLite's own parser never sees a second
 * statement there.
 *
 * **Fail-closed on anything unclosed.** An unterminated quote or block comment
 * returns `undefined` so the caller can decide; both callers fall back to
 * treating the raw text as code, which is the strict reading. Such a statement is
 * a syntax error to SQLite anyway, and masking to end of input would hide a real
 * `;` behind a stray quote.
 *
 * Length and newlines are preserved so an offset derived from the masked copy
 * still indexes the caller's own string.
 */
const maskSqlNonCode = (sql: string): string | undefined => {
    // `split("")`, NOT `[...sql]`. The spread iterates CODE POINTS while every
    // index below — `sql[index]`, `sql.length`, each `fill` bound — is a CODE
    // UNIT offset. One astral character (an emoji in a literal) desynchronises
    // the two, and the fill then runs one slot short, eating the character after
    // the closing quote. When that character is the statement-separating `;`,
    // the gate stops seeing a batch: `SELECT '<emoji>';ANALYZE` masked to
    // `SELECT xxxxANALYZE` and was ALLOWED through to `sql.exec`.
    const out = sql.split("");
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
    for (let at = 0; at < sql.length; at += 1) {
        // Code-unit indexed, for the same reason the buffer is — see above.
        if (sql[at] === "\n") {
            out[at] = "\n";
        }
    }

    return out.join("");
};

export { maskSqlNonCode };
