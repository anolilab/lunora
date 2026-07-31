import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public procedure whose handler calls `ctx.db.insertManyUnsafe(...)`.
 *
 * `insertManyUnsafe` is the bulk-insert escape hatch: it writes rows straight to
 * storage, bypassing the per-row argument validators AND the schema's insert
 * triggers (which is where server-trusted columns, ownership stamping, and RLS
 * write checks live). That is acceptable for a seed script or an internal import
 * fed server-trusted rows — but on a `.public()` procedure the rows are shaped
 * from request input, so the bypass lets a caller write columns they should never
 * control and skip every trigger-enforced invariant. The fix is to use the
 * validated `ctx.db.insert(...)` path, or keep the unsafe bulk write in an
 * internal function fed only server-built rows.
 *
 * Runs only when the codegen feeder supplies procedure-protection evidence
 * (`context.procedureProtections`); a runtime caller flags nothing. One finding
 * per public procedure using the unsafe bulk insert.
 */
const insertManyUnsafeUserData: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure calls `ctx.db.insertManyUnsafe(...)`, which writes rows straight to storage and bypasses both the per-row validators and the schema's insert triggers (server-trusted columns, ownership stamping, RLS write checks). On a public entry point the rows are request-shaped, so a caller can write columns they shouldn't control and skip every trigger-enforced invariant.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "insert_many_unsafe_user_data",
    remediation:
        "Use the validated `ctx.db.insert(...)` path in public procedures so validators and insert triggers run. If you need the unsafe bulk write, move it into an internal function (`internalMutation`/`internalAction`) that is fed only server-constructed rows, never request input.",
    run: (context) => {
        if (context.procedureProtections === undefined) {
            return [];
        }

        // `usesInsertManyUnsafe === undefined` means the feeder couldn't read the
        // handler body (a cross-file handler) — stays fail-closed, not cleared.
        return context.procedureProtections
            .filter((procedure) => procedure.usesInsertManyUnsafe !== false && procedure.visibility === "public")
            .map((procedure) =>
                emit(insertManyUnsafeUserData, {
                    cacheKey: `insert_many_unsafe_user_data:${procedure.file}:${procedure.exportName}`,
                    detail: `\`${procedure.exportName}\` (${procedure.file}) is public and calls \`ctx.db.insertManyUnsafe(...)\`, bypassing validators and insert triggers on request-shaped rows. Switch to \`ctx.db.insert(...)\`, or move the bulk write into an internal function fed server-built rows.`,
                    metadata: { exportName: procedure.exportName, file: procedure.file, kind: procedure.kind },
                }),
            );
    },
    source: "static",
    title: "Public procedure uses insertManyUnsafe (bypasses validators and triggers)",
};

export default insertManyUnsafeUserData;
