import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, queryReadLocation, shardKindsByTable } from "../helpers";

/**
 * Flags a `count()` on a table that declares no aggregate index. `count()` reads a counter
 * only when an aggregate index covers it; otherwise it runs `SELECT COUNT(*)` over the
 * table, reading every row on each call. A count that runs per request or per poll repeats
 * that scan every time, and its cost grows with the table.
 *
 * The verdict is per table. A table that declares an aggregate index is not flagged, even
 * when a particular `where` falls outside that index, because the feeder cannot judge the
 * index's coverage. That is a known false negative. The count reads come from the codegen
 * feeder; runtime callers supply none, so this lint is a no-op there.
 */
const countWithoutIndex: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A `count()` runs on a table with no aggregate index, so every call scans every row of the table to count them. The cost grows with the table, and repeats on every call.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "count_without_index",
    remediation:
        "Declare an aggregate index that covers the count (`.aggregateIndex(name, { by: [...] })` on the table, or `defineAggregateIndex` in the schema) so `count()` reads a counter. For a small table or a count that runs rarely, the scan may be acceptable.",
    run: (context) => {
        const findings = [];
        const shardKindByTable = shardKindsByTable(context.schema);

        for (const read of context.countReads ?? []) {
            if (read.indexed) {
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

            findings.push(
                emit(countWithoutIndex, {
                    cacheKey,
                    detail: `count() on "${read.table}" at ${location} has no aggregate index, so it scans every row of "${read.table}" to count them.`,
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
