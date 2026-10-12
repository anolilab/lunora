import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, indexFieldsLookup, queryReadLocation } from "../helpers";
import { openRangeSweepReads, uncoveredFilterFields } from "../sweeps";

/**
 * Flags a server-driven `.withIndex(…).collect()` on an open range that nothing in
 * the same function makes progress on. The sweep itself is defined in `../sweeps`.
 *
 * Each run of such a sweep reads the whole open range again. The rows it found on
 * the last run are still there, so the next run selects them too, and the work
 * grows with the table. A `.take(n)` or `.paginate(…)` ends the chain in another
 * terminal, so this rule never sees those reads. A `.collect()` with no index at all
 * is `unbounded_collect`'s.
 *
 * Progress counts a delete or replace in the function or in anything it calls, and
 * a patch that writes an index field of the range. A patch of other fields leaves
 * the rows in range, so it does not count.
 *
 * When the read also filters on a field the index does not cover, the finding says
 * so. This rule and `filter_after_index_scan` agree on one finding per read: this
 * one asks for a bound, and the filter's own finding is suppressed.
 *
 * Runs only when the codegen feeder supplied reads (`context.queries` present);
 * a runtime caller supplies none and so flags nothing.
 */
const unboundedCollectOnOpenRange: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A server-driven function (an internal procedure, or one a scheduled dispatch or cron job runs) calls `.collect()` on an open index range, with no upper bound and no take/paginate, and nothing it runs removes the rows it selects. Each run reads the whole range again, and the cost grows with the table.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "unbounded_collect_on_open_range",
    remediation:
        "Bound the range from above (`.withIndex(…, (q) => q.eq(…).lt(…, cutoff))`), cap it with `.take(n)`, or page it with `.paginate(…)` and carry the cursor to the next run. A sweep that never removes the rows it selects keeps selecting them, so delete or update the rows it has handled, or move the cursor past them.",
    run: (context) => {
        const indexFieldsOf = indexFieldsLookup(context.schema);

        return openRangeSweepReads(context).map((read) => {
            const indexName = read.index?.name ?? "(computed)";
            const uncovered = uncoveredFilterFields(read, indexFieldsOf(read));
            const filters =
                uncovered.length === 0 ? "" : ` It also filters on ${uncovered.map((field) => `"${field}"`).join(", ")}, which the index does not cover.`;

            return emit(unboundedCollectOnOpenRange, {
                cacheKey: `unbounded_collect_on_open_range:${read.file}:${read.line.toString()}:${read.table}`,
                detail: `Server-driven read of "${read.table}" at ${queryReadLocation(read)} collects the open range of index "${indexName}" with no upper bound. Nothing it runs removes the rows it selects, so every run reads the whole range again.${filters}`,
                metadata: { ...callSiteFields(read), filteredFields: uncovered, indexName, table: read.table },
            });
        });
    },
    source: "static",
    title: "Unbounded collect on an open index range",
};

export default unboundedCollectOnOpenRange;
