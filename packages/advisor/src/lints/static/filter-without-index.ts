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
        const shardKindByTable = new Map(context.schema.tables.map((table) => [table.name, table.shardKind]));

        for (const read of context.queries ?? []) {
            // Only an *unindexed* filter on a known table is a scan we can name.
            if (!read.hasFilter || read.hasIndex || read.table === "") {
                continue;
            }

            // A primary-key filter is reported by `filter_on_primary_key`, whose
            // remediation is `ctx.db.get(id)` — not an index. Two findings on
            // one read, pointing at different fixes, is worse than one.
            if (read.filtersPrimaryKey === true) {
                continue;
            }

            const location = read.line > 0 ? `${read.file}:${read.line.toString()}` : read.file;
            const shardKind = shardKindByTable.get(read.table);
            const metadata = { exportName: read.exportName, file: read.file, line: read.line, shardKind: shardKind ?? "unknown", table: read.table };
            const cacheKey = `filter_without_index:${read.file}:${read.line.toString()}:${read.table}`;

            // A `.shardBy()` table's rows are partitioned across Durable Objects
            // and a query runs inside ONE of them, so this reads a single
            // tenant's rows — not the table. Reporting it identically to a scan
            // of a `.global()` D1 table (which genuinely is unbounded) makes the
            // two cases that need very different responses look the same
            // (LUNORA_ISSUES #41).
            if (shardKind === "shardBy") {
                findings.push(
                    emit(filterWithoutIndex, {
                        cacheKey,
                        detail: `Query on "${read.table}" at ${location} calls .filter() without an index. "${read.table}" is \`.shardBy()\`, so the read is already scoped to one shard rather than the whole table — this is bounded by one tenant's row count, not the dataset. Add an index if that per-shard count grows large.`,
                        level: "INFO",
                        metadata,
                    }),
                );

                continue;
            }

            // `root` is the default single-Durable-Object table (its own SQLite),
            // NOT D1 — `global` is the D1 tier. Both scan every row, but the
            // cost differs enough to say which one you are paying, and an
            // unrecognised table (an external/unknown tier) gets the neutral
            // wording rather than a claim about storage we cannot make.
            const scope =
                {
                    global: `it scans the whole D1 table "${read.table}" — unbounded, and the cost is a cross-region round trip`,
                    root: `it loads every row of "${read.table}" from the root Durable Object's SQLite and filters in memory`,
                }[shardKind as "global" | "root"] ?? `it loads every row of "${read.table}" and filters in memory`;

            findings.push(
                emit(filterWithoutIndex, {
                    cacheKey,
                    detail: `Query on "${read.table}" at ${location} calls .filter() without an index — ${scope}.`,
                    metadata,
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Filter without index",
};

export default filterWithoutIndex;
