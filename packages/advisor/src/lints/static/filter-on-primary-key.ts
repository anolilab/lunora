import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags `ctx.db.query("t").filter((d) => d._id === x)` — a full scan for a row
 * that is directly addressable.
 *
 * Unlike `filter_without_index`, this is never a judgement call. `_id` is the
 * primary key: `ctx.db.get(x)` fetches the row by rowid, while the filter form
 * walks the table comparing every `_id` until it matches. There is no schema
 * shape, table size, or access pattern under which the scan is the right
 * choice, so the fix is mechanical and the finding needs no triage.
 *
 * Split out from `filter_without_index` because that rule fires on a spectrum —
 * some of its findings are fine, some want an index, and the reader has to
 * decide. Folding an always-wrong case into a sometimes-wrong rule buries it
 * (found while reviewing eight `filter_without_index`
 * findings, one of which was this and strictly worse than the rest).
 *
 * Runs only when the codegen feeder supplies query evidence; a runtime caller
 * flags nothing.
 */
const filterOnPrimaryKey: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A query filters on `_id`, the primary key. That walks the table comparing every row's id, when `ctx.db.get(id)` fetches the row directly. There is no case where the scan is preferable.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "filter_on_primary_key",
    remediation:
        'Replace `ctx.db.query("table").filter((d) => d._id === id).first()` with `ctx.db.get(id)`. Passing a typed `Id<"table">` also narrows the result to that table\'s `Doc`, where the scan form returns the shared row type.',
    run: (context) => {
        const findings = [];

        for (const read of context.queries ?? []) {
            if (read.filtersPrimaryKey !== true || read.table === "") {
                continue;
            }

            const location = read.line > 0 ? `${read.file}:${read.line.toString()}` : read.file;

            findings.push(
                emit(filterOnPrimaryKey, {
                    cacheKey: `filter_on_primary_key:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Query on "${read.table}" at ${location} filters on \`_id\` — it scans "${read.table}" to find a row \`ctx.db.get(id)\` addresses directly.`,
                    metadata: { exportName: read.exportName, file: read.file, line: read.line, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Filter on primary key instead of ctx.db.get",
};

export default filterOnPrimaryKey;
