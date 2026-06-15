import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a public procedure that reads a table for which at least one other
 * procedure declares a column mask (evidence the developer decided that table
 * carries sensitive columns), but whose own builder chain does NOT include
 * `.use(mask(...))`.
 *
 * Lunora masking is **opt-in per procedure**: a `mask(policies)` object only
 * redacts columns inside procedures whose builder chain includes
 * `.use(mask(policies))`. A procedure without it returns the raw column value —
 * even when another procedure in the same app declares that column maskable.
 * This is the "one procedure masks `users.email`, another leaks it" failure
 * mode, the column-level sibling of `rls_uncovered_table`.
 *
 * **Granularity**: the lint is table-granular, not column-precise. Statically
 * proving that a procedure *returns* a specific masked column would need
 * return-shape analysis that is infeasible over the IR; instead the lint flags a
 * public procedure that *reads* a mask-covered table without any
 * `.use(mask(...))` of its own, and the finding lists the masked columns the
 * developer flagged elsewhere. Only reads are considered — masking is a
 * read/return-path concern, so writes never trigger it.
 *
 * **Scope**: only `public` procedures are flagged. `internal*` procedures
 * (e.g. `internalQuery`, `internalMutation`) intentionally bypass masking, so
 * flagging them would produce only noise. Remediation text notes this exemption.
 *
 * **Evidence supply**: this lint runs only when the codegen feeder has supplied
 * `context.maskProcedures`; a runtime caller with no evidence flags nothing
 * rather than raising false alarms.
 *
 * **Conservative policy detection**: when a procedure calls `mask(policies)`
 * with a non-literal object (a variable reference), the feeder cannot statically
 * enumerate the masked `(table, column)` pairs. In that case the procedure is
 * still marked `usesMask: true` (so it is NOT itself flagged), but its pairs
 * contribute nothing to the masked-column map. The lint may under-report (false
 * negatives) when policies are extracted into named constants, but never
 * over-reports (no false positives).
 */
const maskUncoveredPiiColumn: Lint = {
    categories: ["SECURITY"],
    description:
        "A public procedure reads a table whose columns are masked by `.use(mask(...))` elsewhere in the app, but this procedure's builder chain does not include `.use(mask(...))`. It returns those columns in the clear while a sibling procedure redacts them.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "mask_uncovered_pii_column",
    remediation:
        "Add `.use(mask(policies))` to the procedure's builder chain — e.g. `c.use(mask(myMasks)).query(...)` — so its returned rows redact the same columns as the rest of the app. If this procedure is intentionally privileged (e.g. an admin export), declare it with `internalQuery` / `internalMutation` / `internalAction` instead of the public builder so the intent is explicit.",
    // eslint-disable-next-line sonarjs/cognitive-complexity -- the procedure/table/column cross-reference reads clearest as one linear pass; splitting it would obscure the flow.
    run: (context) => {
        // No mask procedure evidence supplied → nothing to assert.
        if (context.maskProcedures === undefined) {
            return [];
        }

        // Collect, app-wide, the masked columns declared for each table. A table
        // appearing here carries at least one column the developer chose to mask.
        const maskedColumnsByTable = new Map<string, Set<string>>();

        for (const procedure of context.maskProcedures) {
            for (const { column, table } of procedure.maskColumns) {
                if (table === "" || column === "") {
                    continue;
                }

                const columns = maskedColumnsByTable.get(table) ?? new Set<string>();

                columns.add(column);
                maskedColumnsByTable.set(table, columns);
            }
        }

        // No statically-discoverable masked columns → nothing to flag.
        if (maskedColumnsByTable.size === 0) {
            return [];
        }

        const findings = [];

        for (const procedure of context.maskProcedures) {
            // Already masks → skip.
            if (procedure.usesMask) {
                continue;
            }

            // Internal procedures intentionally bypass the public mask gate.
            if (procedure.visibility === "internal") {
                continue;
            }

            // Collect the mask-covered tables this procedure reads.
            const touched = new Set<string>();

            for (const table of procedure.tablesRead) {
                if (table !== "" && maskedColumnsByTable.has(table)) {
                    touched.add(table);
                }
            }

            for (const table of touched) {
                const columns = [...(maskedColumnsByTable.get(table) ?? new Set<string>())].toSorted((a, b) => a.localeCompare(b));
                const columnList = columns.map((column) => `\`${column}\``).join(", ");

                findings.push(
                    emit(maskUncoveredPiiColumn, {
                        cacheKey: `mask_uncovered_pii_column:${procedure.file}:${procedure.exportName}:${table}`,
                        detail: `\`${procedure.exportName}\` in ${procedure.file} reads table \`${table}\` without \`.use(mask(...))\` — its column${columns.length === 1 ? "" : "s"} ${columnList} ${columns.length === 1 ? "is" : "are"} masked elsewhere in the app but returned in the clear here.`,
                        metadata: { columns, exportName: procedure.exportName, file: procedure.file, table },
                    }),
                );
            }
        }

        return findings;
    },
    source: "static",
    title: "Maskable column returned without mask() middleware",
};

export default maskUncoveredPiiColumn;
