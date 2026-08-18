import { classifyStatement } from "../../../../../shared/sql-readonly";
import { maskNonCode } from "./sql-context";

/** One statement from a script: its text, and why the gate refused it. */
interface ScriptStatement {
    /** The gate's message when this statement cannot run, else `undefined`. */
    readonly rejection?: string;
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
 * Splits on the comment/literal-MASKED copy of the text (`maskNonCode`), which
 * preserves offsets — a `;` inside a string or a `--` comment is not a statement
 * boundary, and splitting on the raw text would tear one statement in half and
 * send both halves.
 */
const splitStatements = (sql: string): ScriptStatement[] => {
    const masked = maskNonCode(sql);
    const parts: ScriptStatement[] = [];
    let start = 0;

    for (let index = 0; index <= masked.length; index += 1) {
        if (index !== masked.length && masked[index] !== ";") {
            continue;
        }

        // Slice the ORIGINAL, not the mask: the mask exists only to locate the
        // boundary, and the operator's own text is what runs.
        const part = sql.slice(start, index).trim();

        start = index + 1;

        if (part !== "") {
            const rejection = classifyStatement(part);

            parts.push(rejection === undefined ? { sql: part } : { rejection: rejection.message, sql: part });
        }
    }

    return parts;
};

export { splitStatements };
export type { ScriptStatement };
