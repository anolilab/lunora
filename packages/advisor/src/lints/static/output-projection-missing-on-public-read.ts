import emit from "../../finding";
import type { Finding, Lint } from "../../types";
import { PII_FIELD_NAMES } from "../helpers";

/**
 * Nudges a `.public()` `query` whose handler returns raw table rows — with no
 * `.output(...)` projection and no `.use(mask(...))` — when that table carries
 * PII-named columns (`email`, `phone`, `ssn`, …).
 *
 * A public query is reachable by any client. Returning a table row verbatim ships
 * every column it holds — including PII the caller never needed — and silently
 * widens the exposed surface every time a column is added to the table later. An
 * explicit `.output(v.object({ … }))` projection (or a `.use(mask(...))` policy)
 * makes the exposed shape intentional and stops the next-added column from leaking
 * by default. This is an INFO-level nudge, not a defect: the query may be perfectly
 * fine — it flags a place worth a deliberate projection decision.
 *
 * **Low-FP gates**: the feeder records a row only when the handler returns the raw
 * read result itself (a hand-built object / array / `.map(...)` projection is not
 * recorded), and this lint additionally requires (1) `visibility === "public"`,
 * (2) no `.output(...)` and no `.use(mask(...))` on the builder chain, and (3) the
 * returned table to declare at least one PII-named column. A public query returning
 * a non-PII lookup table (`emojis`, `countries`) is never flagged.
 *
 * Runs only when the codegen feeder supplies `context.rawRowReturns`; a runtime
 * caller flags nothing.
 */
const outputProjectionMissingOnPublicRead: Lint = {
    categories: ["SECURITY"],
    description:
        "A `.public()` `query` returns raw table rows (no `.output(...)` projection, no `.use(mask(...))`) from a table carrying PII-named columns (`email`, `phone`, `ssn`, …). Every column ships to the caller, and a column added to the table later leaks by default.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "output_projection_missing_on_public_read",
    remediation:
        "Add an explicit return projection to the public query — `.output(v.object({ … }))` listing only the fields a client needs — or apply a `.use(mask(...))` policy to the PII columns. This makes the exposed shape intentional and stops a newly-added column from leaking through this query by default.",
    run: (context) => {
        if (context.rawRowReturns === undefined) {
            return [];
        }

        // Map each schema table to its PII-named columns once, so the per-row join is O(1).
        const piiColumnsByTable = new Map<string, string[]>();

        for (const table of context.schema.tables) {
            const piiColumns = table.fields.filter((field) => PII_FIELD_NAMES.has(field));

            if (piiColumns.length > 0) {
                piiColumnsByTable.set(table.name, piiColumns);
            }
        }

        const findings: Finding[] = [];

        for (const row of context.rawRowReturns) {
            if (row.visibility !== "public" || row.usesOutput || row.usesMask || row.table === "") {
                continue;
            }

            const piiColumns = piiColumnsByTable.get(row.table);

            if (piiColumns === undefined) {
                continue;
            }

            findings.push(
                emit(outputProjectionMissingOnPublicRead, {
                    cacheKey: `output_projection_missing_on_public_read:${row.file}:${row.line.toString()}`,
                    detail: `Public query \`${row.exportName}\` (${row.file}:${row.line.toString()}) returns raw \`${row.table}\` rows with no \`.output(...)\` projection — shipping PII column(s) ${piiColumns.join(", ")} to every caller, and any column added to \`${row.table}\` later leaks by default. Project the return with \`.output(v.object({ … }))\` or mask the PII columns.`,
                    metadata: {
                        columns: piiColumns,
                        exportName: row.exportName,
                        file: row.file,
                        line: row.line,
                        table: row.table,
                    },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Public query returns raw rows with PII and no output projection",
};

export default outputProjectionMissingOnPublicRead;
