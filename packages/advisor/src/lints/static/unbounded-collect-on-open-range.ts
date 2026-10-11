import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, functionKeysOf, queryReadLocation, readRowsChanged, rowChangingWriteKeys, scheduledFunctionKeys } from "../helpers";

/** The comparators that bound an index range from above. A range without one reads from its lower end to the end of the index. */
const UPPER_BOUNDS: ReadonlySet<string> = new Set(["lt", "lte"]);

/**
 * Flags a `.withIndex(…).collect()` whose index range has no upper bound, when the
 * read runs from the server and nothing in the same function removes the rows it
 * selects.
 *
 * Each run of such a sweep reads the whole open range again. The rows it found on
 * the last run are still there, so the next run selects them too, and the work
 * grows with the table. A range is open when no `lt`/`lte` bounds it. A bare
 * `.withIndex(name)` (no callback) is the widest open range there is.
 *
 * "Server-driven" means an internal procedure or a function a scheduler edge or a
 * cron job reaches. A range made only of `eq` is a lookup for one value, not a
 * sweep, so it is flagged only when the scheduler or a cron runs it.
 *
 * A `.take(n)` or `.paginate(…)` ends the chain in another terminal, so this rule
 * never sees those reads. A `.collect()` with no index at all is `unbounded_collect`'s.
 * A read that also filters on a field the index does not cover is reported here
 * and by `filter_after_index_scan`: this rule asks for a bound, that one asks for
 * the index to cover the field.
 *
 * Runs only when the codegen feeder supplied reads (`context.queries` present);
 * a runtime caller supplies none and so flags nothing.
 */
const unboundedCollectOnOpenRange: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A server-driven function (an internal procedure, or one a scheduled dispatch or cron job runs) calls `.collect()` on an open index range, with no upper bound and no take/paginate, and nothing in the same function removes the rows it selects. Each run reads the whole range again, and the cost grows with the table.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "unbounded_collect_on_open_range",
    remediation:
        "Bound the range from above (`.withIndex(…, (q) => q.eq(…).lt(…, cutoff))`), cap it with `.take(n)`, or page it with `.paginate(…)` and carry the cursor to the next run. A sweep that never removes the rows it selects keeps selecting them, so delete or update the rows it has handled, or move the cursor past them.",
    run: (context) => {
        const scheduled = scheduledFunctionKeys(context.callEdges, context.cronTargets);
        const rowChanged = rowChangingWriteKeys(context.tableWrites);
        const findings = [];

        for (const read of context.queries ?? []) {
            // Only a `withIndex` range whose bounds we can read. A search or geo index is not a range,
            // and an unreadable callback is no evidence of an open range.
            if (read.terminal !== "collect" || read.table === "" || read.index?.bounds === undefined) {
                continue;
            }

            const { bounds } = read.index;

            if (bounds.some((bound) => UPPER_BOUNDS.has(bound))) {
                continue;
            }

            // A range of only `eq` pins one value: a lookup, which is a sweep only when the server schedules it.
            const lookup = bounds.length > 0 && bounds.every((bound) => bound === "eq");
            const keys = functionKeysOf(read.file, read.scope);
            const driven = keys.some((key) => scheduled.has(key));
            const serverDriven = driven || (read.visibility === "internal" && !lookup);

            if (!serverDriven || readRowsChanged(rowChanged, read)) {
                continue;
            }

            const indexName = read.index.name ?? "(computed)";

            findings.push(
                emit(unboundedCollectOnOpenRange, {
                    cacheKey: `unbounded_collect_on_open_range:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Server-driven read of "${read.table}" at ${queryReadLocation(read)} collects the open range of index "${indexName}" with no upper bound. Nothing in the same function removes the rows it selects, so every run reads the whole range again.`,
                    metadata: { ...callSiteFields(read), indexName, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Unbounded collect on an open index range",
};

export default unboundedCollectOnOpenRange;
