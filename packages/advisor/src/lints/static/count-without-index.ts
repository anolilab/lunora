import type { AdvisorCountRead } from "../../counts";
import emit from "../../finding";
import type { Lint, LintContext } from "../../types";
import { callSiteFields, queryReadLocation, shardKindsByTable } from "../helpers";
import { leadingIndexedColumns, PRIMARY_KEY } from "./fk-index";

/**
 * `true` when SQLite can serve the count's `where` from an index, so the count is a range scan
 * and not a scan of the whole table. A test on `_id` is a primary-key lookup. Otherwise some
 * ordinary index must lead with a field the `where` tests, by SQLite's leftmost-prefix rule
 * (see {@link leadingIndexedColumns}). A bare count tests nothing, so it is never served.
 */
const whereIsIndexBacked = (context: LintContext, read: AdvisorCountRead): boolean => {
    const fields = read.filterFields ?? [];
    const table = context.schema.tables.find((candidate) => candidate.name === read.table);

    if (table === undefined || fields.length === 0) {
        return false;
    }

    const leading = leadingIndexedColumns(table);

    return fields.some((field) => field === PRIMARY_KEY || leading.has(field));
};

/**
 * Flags a `count()` that runs `SELECT COUNT(*)` over a table with no aggregate index, and
 * whose `where` no ordinary index leads with. `count()` reads a counter only when an aggregate
 * index covers it. A bare count, or one whose `where` tests only fields no index leads with,
 * reads every row on each call. A count whose `where` leads with an indexed field, or tests
 * `_id`, runs a range scan, so it is not flagged. A count that runs per request or per poll
 * repeats the scan every time, and its cost grows with the table.
 *
 * The verdict is per call. A table that declares an aggregate index is not flagged, even
 * when a particular `where` falls outside that index, because the feeder cannot judge the
 * index's coverage. That is a known false negative. A `where` the feeder cannot read (a
 * variable, a spread, an options object) is treated as unfiltered, which is also a known
 * false positive when an index does cover it. The feeder records field names, not operators,
 * so a non-equality test on an indexed field (`ne`, `contains`) is cleared too, which is a
 * known false negative. The count reads come from the codegen feeder; runtime callers supply
 * none, so this lint is a no-op there.
 */
const countWithoutIndex: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A `count()` runs on a table with no aggregate index, and no ordinary index covers its `where`, so every call scans every row of the table to count them. The cost grows with the table, and repeats on every call.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "count_without_index",
    remediation:
        "Declare an aggregate index that covers the count (`.aggregateIndex(name, { by: [...] })` on the table, or `defineAggregateIndex` in the schema) so `count()` reads a counter. For a small table or a count that runs rarely, the scan may be acceptable.",
    run: (context) => {
        const findings = [];
        const shardKindByTable = shardKindsByTable(context.schema);

        for (const read of context.countReads ?? []) {
            if (read.indexed || whereIsIndexBacked(context, read)) {
                continue;
            }

            const location = queryReadLocation(read);
            const shardKind = shardKindByTable.get(read.table);
            const metadata = { ...callSiteFields(read), shardKind: shardKind ?? "unknown", table: read.table };
            const cacheKey = `count_without_index:${read.file}:${read.line.toString()}:${read.table}`;

            // A `.shardBy()` table's rows are split across Durable Objects, and a count runs inside
            // one of them, so it counts a single tenant's rows rather than the table. Reported at INFO.
            if (shardKind === "shardBy") {
                findings.push(
                    emit(countWithoutIndex, {
                        cacheKey,
                        detail: `count() on "${read.table}" at ${location} has no aggregate index. "${read.table}" is \`.shardBy()\`, so the count covers one shard's rows, not the whole table. It is bounded by one tenant's row count.`,
                        level: "INFO",
                        metadata,
                    }),
                );

                continue;
            }

            const fields = read.filterFields ?? [];
            const why =
                fields.length > 0
                    ? `and no index leads with a field its where tests (${fields.map((field) => `"${field}"`).join(", ")}), so it scans`
                    : "so it scans";

            findings.push(
                emit(countWithoutIndex, {
                    cacheKey,
                    detail: `count() on "${read.table}" at ${location} has no aggregate index, ${why} every row of "${read.table}" to count them.`,
                    metadata,
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Count without index",
};

export default countWithoutIndex;
