import emit from "../../finding";
import type { Finding, Lint } from "../../types";

/** Human-readable phrasing for each id-first sink the normalized id reaches. */
const SINK_LABELS: Record<"delete" | "get" | "patch", string> = {
    delete: "deletes the row",
    get: "reads the row",
    patch: "patches the row",
};

/**
 * Flags a public `query`/`mutation` whose handler gates a `ctx.db.get`/`patch`/`delete`
 * on a null-checked `ctx.db.normalizeId(table, id)` result, with no intervening
 * ownership predicate and no RLS coverage.
 *
 * `normalizeId` performs pure structural validation — it checks that a string is
 * shaped like a valid id for `table` and returns the branded id, but it **never reads
 * the database**. A non-null result therefore proves only that the id is well-formed,
 * never that the row exists or that the caller owns it. Treating "normalizeId returned
 * non-null" as authorization is an IDOR: any caller who supplies a syntactically valid
 * id of another user's row reaches it. This is an INFO-level nudge — the handler may be
 * intentionally public — it flags a place where the shape check is doing load-bearing
 * work it can't actually do.
 *
 * **Negative-proof gates** (bias toward silence — a false negative is cheaper than a
 * false positive that trains users to ignore the advisor): the feeder records a row
 * only when a null-gated normalized id reaches an id-first sink, and this lint
 * additionally requires (1) `visibility === "public"` (an internal procedure trusts
 * its server caller for authorization), (2) no `.use(rls(...))` on the builder chain,
 * (3) no ownership/identity mention anywhere in the handler (`mentionsOwnership` — any
 * `ctx.auth`/`ctx.identity` read or ownership-named identifier suppresses), and (4) the
 * table not covered by schema-required RLS. A handler that compares the loaded row's
 * `userId` to `ctx.auth.userId`, or a schema in `.rls("required")` mode, is never
 * flagged.
 *
 * Runs only when the codegen feeder supplies `context.normalizeIdAuthorizations`; a
 * runtime caller flags nothing.
 */
const normalizeIdUsedAsAuthorization: Lint = {
    categories: ["SECURITY"],
    description:
        "A `.public()` `query`/`mutation` gates a `ctx.db.get`/`patch`/`delete` on a null-checked `ctx.db.normalizeId(table, id)` result with no ownership predicate and no RLS. `normalizeId` validates id *shape* only — it never reads the database — so a non-null result proves the id is well-formed, never that the caller owns the row (an IDOR).",
    facing: "EXTERNAL",
    level: "INFO",
    name: "normalize_id_used_as_authorization",
    remediation:
        'Don\'t treat a non-null `normalizeId` result as authorization — it only validates id shape. After loading the row, compare its ownership column (`userId`/`ownerId`/…) against the server-trusted identity (`ctx.auth.userId`), or protect the procedure with `.use(rls(...))` / put the schema in `.rls("required")` mode so the row policy runs on every access.',
    run: (context) => {
        if (context.normalizeIdAuthorizations === undefined) {
            return [];
        }

        // Schema-required RLS covers every table's access path except a table that opted out via `.public()`.
        const rlsRequired = context.schema.rlsMode === "required";
        const rlsOptOutTables = new Set(context.schema.tables.filter((table) => table.isPublic).map((table) => table.name));

        const findings: Finding[] = [];

        for (const row of context.normalizeIdAuthorizations) {
            if (row.visibility !== "public" || row.usesRls || row.mentionsOwnership) {
                continue;
            }

            // Under required RLS the access path is covered unless we can positively identify a `.public()` opt-out for this table.
            if (rlsRequired && (row.table === "" || !rlsOptOutTables.has(row.table))) {
                continue;
            }

            const target = row.table === "" ? "the row" : `the \`${row.table}\` row`;

            findings.push(
                emit(normalizeIdUsedAsAuthorization, {
                    cacheKey: `normalize_id_used_as_authorization:${row.file}:${row.line.toString()}`,
                    detail: `Public procedure \`${row.exportName}\` (${row.file}:${row.line.toString()}) gates access on \`ctx.db.normalizeId(...)\` and then ${SINK_LABELS[row.sinkMethod]} — but \`normalizeId\` only validates id shape, it never reads the database or checks ownership. Any caller supplying a well-formed id of ${target} reaches it (IDOR). Compare the loaded row's ownership column against \`ctx.auth\`, or cover the procedure with \`.use(rls(...))\`.`,
                    metadata: {
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        sinkMethod: row.sinkMethod,
                        table: row.table,
                    },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "normalizeId result used as authorization (validates id shape, not ownership)",
};

export default normalizeIdUsedAsAuthorization;
