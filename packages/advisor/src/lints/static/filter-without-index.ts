import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a query read that calls `.filter()` without first narrowing with
 * `.withIndex()` / `.withSearchIndex()`. Such a read loads *every* row of the
 * table and applies the predicate in memory — a full table scan that degrades
 * linearly as the table grows. The healthy pattern is `.withIndex(...)` to
 * narrow, then `.filter(...)` only for predicates the index can't express
 * (which is why an indexed read with a trailing `.filter()` is NOT flagged).
 *
 * The query reads come from the codegen feeder, which parses
 * `ctx.db.query("table")…` chains out of function bodies. Runtime callers supply
 * no `queries`, so this lint is a no-op there.
 */
const filterWithoutIndex: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A query calls `.filter()` without a `.withIndex()` / `.withSearchIndex()`, so it loads every row in the table and filters in memory — a full table scan that gets linearly slower as the table grows.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "filter_without_index",
    remediation: 'Narrow the read with `.withIndex("name", (q) => q.eq(...))` first, then `.filter()` only for what the index cannot express.',
    run: (context) => {
        const findings = [];

        for (const read of context.queries ?? []) {
            // Only an *unindexed* filter on a known table is a scan we can name.
            if (!read.hasFilter || read.hasIndex || read.table === "") {
                continue;
            }

            const location = read.line > 0 ? `${read.file}:${read.line.toString()}` : read.file;

            findings.push(
                emit(filterWithoutIndex, {
                    cacheKey: `filter_without_index:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Query on "${read.table}" at ${location} calls .filter() without an index — it loads every row of "${read.table}" and filters in memory.`,
                    metadata: { exportName: read.exportName, file: read.file, line: read.line, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Filter without index",
};

export default filterWithoutIndex;
