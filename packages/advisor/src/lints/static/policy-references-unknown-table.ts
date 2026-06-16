import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags an RLS policy whose `table` names a table that does not exist in the
 * schema.
 *
 * A policy is bound to a table by a plain string (`definePolicy({ table:
 * "documents", … })`). The `rls()` middleware only applies a policy to reads and
 * writes of that exact table name — so a typo, a stale name after a rename, or a
 * copy-paste mistake produces a policy that silently matches **nothing**. The
 * table the developer believes is gated is left completely ungated, which is a
 * security gap, not a mere dead-code wart: every read of the real table returns
 * unrestricted rows and every write is allowed.
 *
 * This is strictly worse than `rls_uncovered_table` (a procedure forgetting the
 * middleware): here the middleware *is* wired up, the policy *is* in the list,
 * and it still does nothing — the failure is invisible at every call site.
 *
 * **Evidence supply**: like `rls_uncovered_table`, this runs only when the
 * codegen feeder supplies `context.rlsProcedures`. The covered-table names come
 * from each procedure's statically-read `rls(policies)` array (`rlsTables`); a
 * policies argument that isn't a literal array contributes no names, so the lint
 * under-reports rather than raising false alarms.
 */
const policyReferencesUnknownTable: Lint = {
    categories: ["SECURITY"],
    description:
        "An RLS policy is bound to a `table` name that does not exist in the schema. The `rls()` middleware never matches it, so the table the policy was meant to protect is left ungated — reads return unrestricted rows and writes are allowed.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "policy_references_unknown_table",
    remediation:
        "Fix the policy's `table` to a real table name (check for a typo or a table that was renamed/removed). If the table is gone, delete the dead policy.",
    run: (context) => {
        // No RLS procedure evidence supplied → nothing to assert.
        if (context.rlsProcedures === undefined) {
            return [];
        }

        const knownTables = new Set(context.schema.tables.map((table) => table.name));

        // A policy table can appear in many procedures' lists; report each
        // unknown name once, keeping the first procedure that referenced it as
        // the locus so the operator has a file to open.
        const reported = new Set<string>();
        const findings = [];

        for (const procedure of context.rlsProcedures) {
            for (const table of procedure.rlsTables) {
                // Empty string = non-literal policies arg the feeder couldn't read.
                if (table === "" || knownTables.has(table) || reported.has(table)) {
                    continue;
                }

                reported.add(table);

                findings.push(
                    emit(policyReferencesUnknownTable, {
                        cacheKey: `policy_references_unknown_table:${table}`,
                        detail: `An RLS policy in \`${procedure.exportName}\` (${procedure.file}) is bound to table \`${table}\`, which is not declared in the schema. The policy never matches, so \`${table}\` — if it exists under another name — is left ungated.`,
                        metadata: { exportName: procedure.exportName, file: procedure.file, table },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "RLS policy bound to an unknown table",
};

export default policyReferencesUnknownTable;
