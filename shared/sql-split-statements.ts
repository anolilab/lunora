import { maskSqlNonCode } from "./sql-mask";
import type { SqlRejection } from "./sql-readonly";
import { classifyStatement } from "./sql-readonly";

/** One statement from a script: its text, where it starts in the draft, and why the gate refused it. */
interface ScriptStatement {
    /** Index of this statement's first character in the ORIGINAL draft, so a diagnostic can be placed on it. */
    readonly offset: number;
    /** The gate's verdict when this statement cannot run, else `undefined`. Its own offsets are statement-relative. */
    readonly rejection?: SqlRejection;
    readonly sql: string;
}

/**
 * Split a draft into the statements a script means to run, ABOVE the read-only
 * gate.
 *
 * `shared/sql-readonly.ts` rejects any `;` that is not a single trailing one
 * (`SQL_MULTIPLE_STATEMENTS`), and that rule is the enforcement point for the
 * whole SQL console — raw writes bypass the schema-aware writer and desync the
 * doc-store's FTS / aggregate / rank shadow tables. So a script is submitted as
 * N separately-gated calls; the classifier is never relaxed, and each part is
 * classified here too so a refusal is visible before anything is sent.
 *
 * Splits on `shared/sql-mask.ts`'s masked copy — the SAME scanner the gate uses
 * to decide whether a `;` is a batch. That shared scanner is the point: the
 * studio has its own `maskNonCode` in `sql-context.ts`, but that one deliberately
 * treats `"…"` as code because it resolves identifiers, so splitting with it tore
 * `SELECT "a;b" FROM t` into `SELECT "a` (which the gate then ACCEPTS and sends)
 * and `b" FROM t`. A boundary detector and an identifier resolver may not share a
 * mask.
 *
 * A draft the scanner cannot read — an unterminated quote or block comment — is
 * left whole rather than split, so the gate refuses it as a single statement
 * instead of the splitter inventing boundaries inside it.
 */

/**
 * One statement carrying the gate's verdict, or nothing at all when it is blank.
 *
 * `at` is where `raw` began in the draft; the trim is measured so `offset` points
 * at the statement's first real character rather than the whitespace before it.
 */

/**
 * Gate ONE statement, without looking for boundaries inside it. Used by the
 * unreadable-draft fallback below and by the EXPLAIN path, which wraps the whole
 * draft and must therefore be refused as a batch rather than split into a
 * prefix that gets explained and a tail that quietly runs.
 */
const classifyOne = (raw: string, at: number): ScriptStatement[] => {
    const sql = raw.trim();

    if (sql === "") {
        return [];
    }

    const offset = at + raw.indexOf(sql);
    const rejection = classifyStatement(sql);

    return [rejection === undefined ? { offset, sql } : { offset, rejection, sql }];
};

const splitStatements = (sql: string): ScriptStatement[] => {
    const masked = maskSqlNonCode(sql);

    // Unreadable (an unterminated quote or block comment): hand the gate the whole
    // draft as one statement rather than inventing boundaries inside it.
    if (masked === undefined) {
        return classifyOne(sql, 0);
    }

    const parts: ScriptStatement[] = [];
    let start = 0;

    for (let index = 0; index <= masked.length; index += 1) {
        if (index !== masked.length && masked[index] !== ";") {
            continue;
        }

        // Slice the ORIGINAL, not the mask: the mask exists only to locate the
        // boundary, and the operator's own text is what runs.
        parts.push(...classifyOne(sql.slice(start, index), start));

        start = index + 1;
    }

    return parts;
};

export { classifyOne, splitStatements };
export type { ScriptStatement };
