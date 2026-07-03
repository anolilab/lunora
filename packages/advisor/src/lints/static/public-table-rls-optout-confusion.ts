import emit from "../../finding";
import type { Lint } from "../../types";
import { ownershipOrPiiColumns } from "../helpers";

/**
 * Flags a `.public()` table that carries ownership/tenancy- or PII-named
 * columns, on a schema that requires RLS (`.rls("required")`).
 *
 * `.public()`'s name is misleading: it does NOT mean "this table holds public
 * data" — it means the OPPOSITE of that from an enforcement standpoint. It opts
 * one table OUT of the schema-wide `.rls("required")` enforcement, so its
 * `ctx.db` write path is never denied for missing RLS coverage. A table named
 * `.public()` that also carries `userId` / `email` / `ssn`-shaped columns reads
 * as "safe to expose" but is actually "exempt from the row-security guard" —
 * exactly the confusion the method name invites.
 *
 * **Low-FP gate**: only flagged when (1) the schema opted into
 * `.rls("required")` at all (`.public()` is a documented no-op otherwise — see
 * {@link https://lunora.sh}'s `.public()` docs), and (2) the table's declared
 * columns match the ownership/PII heuristic ({@link ownershipOrPiiColumns}). A
 * genuinely public lookup table (e.g. `emojis`, `countries`) with no such
 * columns is not flagged.
 *
 * **Pure schema evidence**: reads only `context.schema` — both `isPublic` and
 * `rlsMode` are forwarded by the runtime `fromServerSchema` and the codegen
 * `toAdvisorSchema` paths, so this lint runs identically from a live shard and
 * from codegen, with no feeder required.
 */
const publicTableRlsOptoutConfusion: Lint = {
    categories: ["SECURITY"],
    description:
        '`.public()` opts a table OUT of the schema\'s `.rls("required")` enforcement — it does not mean the table holds public data. A `.public()` table whose columns look ownership- or PII-shaped (`userId`, `email`, `ssn`, …) is exempt from the row-security guard, not "safe to expose".',
    facing: "EXTERNAL",
    level: "WARN",
    name: "public_table_rls_optout_confusion",
    remediation:
        'Double-check this table actually needs the RLS opt-out. If it does not, remove `.public()` so `.rls("required")` covers it like every other table. If it genuinely must stay open (a shared lookup table, for instance), rename or comment it so the exemption is intentional rather than a name-implies-safety mistake, and make sure no procedure trusts `.public()` as an authorization boundary.',
    run: (context) => {
        if (context.schema.rlsMode !== "required") {
            return [];
        }

        const findings = [];

        for (const table of context.schema.tables) {
            if (!table.isPublic) {
                continue;
            }

            const flaggedColumns = ownershipOrPiiColumns(table);

            if (flaggedColumns.length === 0) {
                continue;
            }

            findings.push(
                emit(publicTableRlsOptoutConfusion, {
                    cacheKey: `public_table_rls_optout_confusion:${table.name}`,
                    detail: `Table "${table.name}" is \`.public()\` (opted OUT of the schema's \`.rls("required")\` enforcement) but carries ownership/PII-shaped column(s): ${flaggedColumns.join(", ")}. \`.public()\` means "exempt from RLS", not "safe to expose" — confirm this table really needs the opt-out.`,
                    metadata: { columns: flaggedColumns, table: table.name },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Public table opts out of RLS but carries sensitive columns",
};

export default publicTableRlsOptoutConfusion;
