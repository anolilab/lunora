import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public read that resurfaces soft-deleted rows via `includeDeleted` —
 * either hardcoded `true` or wired from the handler's `args`.
 *
 * A `.softDelete()` table hides deleted rows from list reads (`findMany` /
 * `findFirst`) unless the call passes `includeDeleted: true`. That opt-out is a
 * deliberate, privileged escape hatch (an admin trash view, a restore flow). On
 * a `.public()` read it becomes a leak: `includeDeleted: true` returns
 * soft-deleted rows to *every* caller, and `includeDeleted: args.showDeleted`
 * lets *any* caller flip the toggle per request — either way the "deleted" rows
 * a user believes are gone (and that your UI hides) are served straight back.
 *
 * INFO, near-zero false positives by construction: it fires only when all of
 * (1) the enclosing procedure is public, (2) the read's target is a schema table
 * that actually declares `.softDelete()`, and (3) `includeDeleted` is a hardcoded
 * `true` or arg-derived. A literal `false`, or an `includeDeleted` gated by a
 * server-trusted `ctx.*` value, is never recorded by the feeder, so a correct
 * admin-gated read is not flagged. Runs only when the codegen feeder supplies
 * `context.softDeleteReads`; a runtime caller flags nothing. One finding per
 * matching read.
 */
const softDeleteIncludeDeletedFromArgs: Lint = {
    categories: ["SECURITY"],
    description:
        "A `.public()` read passes `includeDeleted` (hardcoded `true` or derived from `args`) on a `.softDelete()` table, resurfacing soft-deleted rows to callers that should never see them.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "soft_delete_include_deleted_from_args",
    remediation:
        "Drop `includeDeleted` from the public read so soft-deleted rows stay hidden, or move the trash/restore view behind an internal (or RLS/role-gated) procedure. Never wire `includeDeleted` from `args` on a public read — an attacker can set it to see rows the app treats as deleted.",
    run: (context) => {
        if (context.softDeleteReads === undefined) {
            return [];
        }

        const softDeleteTables = new Set(context.schema.tables.filter((table) => table.softDelete !== undefined).map((table) => table.name));

        if (softDeleteTables.size === 0) {
            return [];
        }

        return context.softDeleteReads
            .filter((row) => row.visibility === "public" && row.table !== "" && softDeleteTables.has(row.table) && (row.hardcodedTrue || row.fromArgs))
            .map((row) => {
                const location = `\`${row.exportName}\` (${row.file}:${row.line.toString()})`;
                const detail = row.fromArgs
                    ? `The public read in ${location} wires \`includeDeleted\` from request \`args\` on soft-delete table \`${row.table}\`, letting any caller resurface soft-deleted rows the app treats as gone.`
                    : `The public read in ${location} hardcodes \`includeDeleted: true\` on soft-delete table \`${row.table}\`, returning soft-deleted rows to every caller.`;

                return emit(softDeleteIncludeDeletedFromArgs, {
                    cacheKey: `soft_delete_include_deleted_from_args:${row.file}:${row.line.toString()}:${row.table}`,
                    detail,
                    metadata: {
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        source: row.fromArgs ? "args" : "literal",
                        table: row.table,
                    },
                });
            });
    },
    source: "static",
    title: "Soft-deleted rows resurfaced via includeDeleted on a public read",
};

export default softDeleteIncludeDeletedFromArgs;
