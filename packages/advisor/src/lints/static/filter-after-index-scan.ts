import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, queryReadLocation } from "../helpers";

/**
 * Flags a `.withIndex(…)` read whose `.filter(…)` tests a field the index does not
 * cover. The index narrows the scan, and the filter then discards most of what it
 * read. Usually the index was meant to cover the filtered field, and the range is
 * just open. Extending the index with that field lets the read seek instead.
 *
 * `filter_without_index` covers the unindexed case. A `.filter()` on the primary
 * key is `filter_on_primary_key`'s, which points at `ctx.db.get`. Both are skipped
 * here so each read gets one finding.
 *
 * Reported at INFO: a filter is sometimes the right tool, for a predicate an index
 * cannot express (a comparison on a second column, a computed value). The finding
 * asks the author to decide, rather than assuming the index is wrong.
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

        for (const read of context.queries ?? []) {
            if (!read.hasFilter || !read.hasIndex || read.table === "" || read.indexName === undefined || read.filterFields === undefined) {
                continue;
            }

            if (read.filtersPrimaryKey === true) {
                continue;
            }

            // An index this schema does not declare is `index_references_unknown_field`'s business, not this rule's.
            const index = context.schema.tables
                .find((table) => table.name === read.table)
                ?.indexes.find((candidate) => candidate.name === read.indexName && candidate.kind === "index");

            if (index === undefined) {
                continue;
            }

            const covered = new Set(index.fields);
            const uncovered = read.filterFields.filter((field) => !covered.has(field));

            if (uncovered.length === 0) {
                continue;
            }

            findings.push(
                emit(filterAfterIndexScan, {
                    cacheKey: `filter_after_index_scan:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Query on "${read.table}" at ${queryReadLocation(read)} narrows with index "${read.indexName}" and then filters on ${uncovered.map((field) => `"${field}"`).join(", ")}, which the index does not cover. The filter reads every row the index range returns and keeps only those that match.`,
                    metadata: { ...callSiteFields(read), filteredFields: uncovered, indexName: read.indexName, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Filter after index scan",
};

export default filterAfterIndexScan;
