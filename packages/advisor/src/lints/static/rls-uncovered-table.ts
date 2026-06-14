import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public procedure that reads or writes a table named in at least one
 * other procedure's `rls(policies)` list, but whose own builder chain does NOT
 * include `.use(rls(...))`.
 *
 * Cirrus RLS is **opt-in per procedure**: a policy list only takes effect
 * inside procedures whose builder chain includes `.use(rls(policies))`. A
 * procedure without it sees the raw, unwrapped `ctx.db` and silently bypasses
 * every policy in the list — even when another procedure in the same app
 * declares that table as policy-gated.
 *
 * The lint surfaces the most dangerous subclass of this failure mode: a table
 * that the developer explicitly decided to gate with RLS (evidenced by naming
 * it in at least one procedure's policy list) is nonetheless accessible
 * without restriction from a procedure that forgot the `.use(rls(...))` call.
 *
 * **Scope**: only `public` procedures are flagged. `internal*` procedures
 * (e.g. `internalQuery`, `internalMutation`) are intentional server-side
 * helpers that legitimately bypass the user-facing RLS gate, so flagging them
 * would produce only noise. Remediation text notes this exemption so authors
 * know to use `internalQuery`/`internalMutation`/`internalAction` when they
 * truly need unwrapped access.
 *
 * **Evidence supply**: this lint runs only when the codegen feeder has supplied
 * `context.rlsProcedures`; a runtime caller with no evidence flags nothing
 * rather than raising false alarms.
 *
 * **Conservative policy-table detection**: when a procedure calls
 * `rls(policies)` with a non-literal array (a variable reference), the feeder
 * cannot statically enumerate the covered tables. In that case the procedure is
 * still marked `usesRls: true` (so it is NOT itself flagged), but its tables
 * contribute nothing to `policyCoveredTables`. This means the lint may
 * under-report (false negatives) when policies are extracted into named
 * constants, but it never over-reports (no false positives).
 */
const rlsUncoveredTable: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure reads or writes a table that is covered by an RLS policy elsewhere in the app, but this procedure's builder chain does not include `.use(rls(...))`. The raw, unwrapped `ctx.db` silently bypasses every policy in the list.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "rls_uncovered_table",
    remediation:
        "Add `.use(rls(policies))` to the procedure's builder chain — e.g. `c.use(rls(myPolicies)).query(...)` — so its `ctx.db` is wrapped by the same policy evaluator as the rest of the app. If this procedure is intentionally privileged (e.g. a background job), declare it with `internalQuery` / `internalMutation` / `internalAction` instead of the public builder so the intent is explicit.",
    // eslint-disable-next-line sonarjs/cognitive-complexity -- the policy/table cross-reference is clearest as one linear pass; splitting it would obscure the flow.
    run: (context) => {
        // No RLS procedure evidence supplied → nothing to assert.
        if (context.rlsProcedures === undefined) {
            return [];
        }

        // Collect all tables that appear in any procedure's rls(policies) list.
        // A table named here is "policy-covered" app-wide.
        const policyCoveredTables = new Set<string>();

        for (const procedure of context.rlsProcedures) {
            for (const table of procedure.rlsTables) {
                if (table !== "") {
                    policyCoveredTables.add(table);
                }
            }
        }

        // No statically-discoverable policy tables → nothing to flag.
        if (policyCoveredTables.size === 0) {
            return [];
        }

        const findings = [];

        for (const procedure of context.rlsProcedures) {
            // Already RLS-protected → skip.
            if (procedure.usesRls) {
                continue;
            }

            // Internal procedures intentionally bypass the public RLS gate.
            if (procedure.visibility === "internal") {
                continue;
            }

            // Collect the policy-covered tables this procedure touches.
            const touched = new Set<string>();

            for (const table of [...procedure.tablesRead, ...procedure.tablesWritten]) {
                if (table !== "" && policyCoveredTables.has(table)) {
                    touched.add(table);
                }
            }

            for (const table of touched) {
                findings.push(
                    emit(rlsUncoveredTable, {
                        cacheKey: `rls_uncovered_table:${procedure.file}:${procedure.exportName}:${table}`,
                        detail: `\`${procedure.exportName}\` in ${procedure.file} accesses table \`${table}\` without \`.use(rls(...))\` — the table is policy-gated elsewhere in the app but this procedure bypasses those policies entirely.`,
                        metadata: { exportName: procedure.exportName, file: procedure.file, table },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "RLS-gated table accessed without rls() middleware",
};

export default rlsUncoveredTable;
