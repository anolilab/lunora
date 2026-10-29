import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, indexFieldsLookup, queryReadLocation } from "../helpers";
import { openRangeSweepReads, uncoveredFilterFields } from "../sweeps";

/**
 * Flags a `.withIndex(…)` read whose `.filter(…)` tests a field the index does not
 * cover. The index narrows the scan, and the filter then discards most of what it
 * read. Usually the index was meant to cover the filtered field, and the range is
 * just open. Extending the index with that field lets the read seek instead.
 *
 * `filter_without_index` covers the unindexed case. The `_id` part of a predicate is
 * not a column of any index: it is `filter_on_primary_key`'s, which points at
 * `ctx.db.get`, so `_id` is never reported here. A predicate that tests `_id` and an
 * uncovered field is still reported, for the field.
 *
 * Reported at INFO: a filter is sometimes the right tool, for a predicate an index
 * cannot express (a comparison on a second column, a computed value). The finding
 * asks the author to decide, rather than assuming the index is wrong. A read that is
 * a server-driven open-range sweep is left to `unbounded_collect_on_open_range`, which
 * reports the same fields, so each read gets one finding.
 *
 * Runs only when the codegen feeder supplied reads (`context.queries` present).
 */
const filterAfterIndexScan: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A query calls `.withIndex(…)` and then `.filter(…)` on a field that index does not cover. The index narrows the scan, and the filter discards most of the rows it read. Extending the index with the field lets the read seek instead of scanning.",
    facing: "EXTERNAL",
    level: "INFO",
    name: "filter_after_index_scan",
    remediation:
        "Add the filtered field to the index the read uses, so the range covers it, or confirm the predicate cannot be expressed as an index range and keep the filter.",
    run: (context) => {
        const findings = [];
        const indexFieldsOf = indexFieldsLookup(context.schema);
        // A read that is a sweep is reported by `unbounded_collect_on_open_range`, which names these fields too.
        const sweeps = new Set(openRangeSweepReads(context));

        for (const read of context.queries ?? []) {
            if (!read.hasFilter || read.table === "" || read.index?.name === undefined || read.filterFields === undefined || sweeps.has(read)) {
                continue;
            }

            const fields = indexFieldsOf(read);

            // An index this schema does not declare is `index_references_unknown_field`'s business, not this rule's.
            if (fields === undefined) {
                continue;
            }

            const uncovered = uncoveredFilterFields(read, fields);

            if (uncovered.length === 0) {
                continue;
            }

            findings.push(
                emit(filterAfterIndexScan, {
                    cacheKey: `filter_after_index_scan:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Query on "${read.table}" at ${queryReadLocation(read)} narrows with index "${read.index.name}" and then filters on ${uncovered.map((field) => `"${field}"`).join(", ")}, which the index does not cover. The filter reads every row the index range returns and keeps only those that match.`,
                    metadata: { ...callSiteFields(read), filteredFields: uncovered, indexName: read.index.name, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Filter after index scan",
};

export default filterAfterIndexScan;
