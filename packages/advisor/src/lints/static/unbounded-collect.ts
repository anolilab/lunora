import emit from "../../finding";
import type { Level, Lint } from "../../types";
import { queryReadLocation, shardKindsByTable } from "../helpers";

/**
 * How a finding is worded and rated per storage tier — what the read actually
 * costs, and how much of the dataset it is bounded by.
 *
 * A `Map`, not an object literal: `shardKind` reaches this as data, so a table
 * whose kind is `"toString"` would resolve to an inherited `Object.prototype`
 * member on an object and skip the neutral fallback below.
 */
const TIERS = new Map<string, { level: Level; scope: (table: string) => string }>([
    ["global", { level: "WARN", scope: (table) => `it reads the whole D1 table "${table}" over a cross-region round trip` }],
    // `root` is the default single-Durable-Object table (its own SQLite), not D1.
    ["root", { level: "WARN", scope: (table) => `it loads every row of "${table}" from the root Durable Object's SQLite into memory` }],
    // A `.shardBy()` table's rows are partitioned across Durable Objects and the
    // read runs inside ONE of them, so this collects a single tenant's rows
    // rather than the dataset. Still unbounded within that tenant — a busy one is
    // exactly where the fan-out hurts — but not the same order of problem.
    [
        "shardBy",
        {
            level: "INFO",
            scope: (table) =>
                `"${table}" is \`.shardBy()\`, so this collects one shard's rows rather than the whole table — bounded by a single tenant's row count`,
        },
    ],
]);

/** An unrecognised tier gets wording that claims nothing about storage we cannot see. */
const UNKNOWN_TIER = { level: "WARN" as Level, scope: (table: string) => `it loads every row of "${table}"` };

/**
 * Flags `ctx.db.query("table").collect()` with no `.withIndex()` and no
 * `.filter()` — a read of every row, materialized in full.
 *
 * `filter_without_index` deliberately does not see this: it gates on
 * `hasFilter`, so the widest read of all — the one that doesn't even filter —
 * falls through it.
 *
 * The cost is not only the scan. A `query`'s result is what a live subscription
 * pushes over the WebSocket, and the DO's refresh gate can only skip a
 * subscription whose reads were confined to index slices. An unindexed
 * `.collect()` records a whole-table dependency instead, so **every** write to
 * the table re-runs the query and re-sends the entire table to **every**
 * subscribed socket, individually. A table that grows to a few thousand rows
 * turns a one-row edit into megabytes of fan-out.
 *
 * The reads come from the codegen feeder, which parses `ctx.db.query("table")…`
 * chains out of function bodies. Runtime callers supply no `queries`, so this
 * lint is a no-op there — as it is for a feeder that predates `terminal`.
 */
const unboundedCollect: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A query calls `.collect()` with no `.withIndex()` and no `.filter()`, so it materializes every row of the table. Any live subscription over it also re-sends that whole result to every subscribed client on every write to the table.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "unbounded_collect",
    remediation:
        'Narrow the read with `.withIndex("name", (q) => q.eq(...))`, cap it with `.take(n)`, or page it with `.paginate(args.paginationOpts)` so neither the scan nor the subscription payload grows with the table.',
    run: (context) => {
        const findings = [];
        const shardKinds = shardKindsByTable(context.schema);

        for (const read of context.queries ?? []) {
            // Not a candidate at all: bounded or narrowed, or a dynamic table we
            // cannot name.
            if (read.terminal !== "collect" || read.hasIndex || read.table === "") {
                continue;
            }

            // A candidate, but `filter_without_index` already reports it and its
            // remediation names the same index — one read must not produce two
            // findings pointing at one fix.
            if (read.hasFilter) {
                continue;
            }

            const shardKind = shardKinds.get(read.table);
            const { level, scope } = TIERS.get(shardKind ?? "") ?? UNKNOWN_TIER;
            const location = queryReadLocation(read);
            const subscriptionCost =
                level === "WARN"
                    ? ` A live subscription over this query records a whole-table dependency, so every write to "${read.table}" re-runs it and re-sends the full result to each subscribed socket.`
                    : " Cap it with `.take(n)` if that count can grow.";

            findings.push(
                emit(unboundedCollect, {
                    cacheKey: `unbounded_collect:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Query on "${read.table}" at ${location} calls .collect() with no index and no filter — ${scope(read.table)}.${subscriptionCost}`,
                    level,
                    metadata: { exportName: read.exportName, file: read.file, line: read.line, shardKind: shardKind ?? "unknown", table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Unbounded collect",
};

export default unboundedCollect;
