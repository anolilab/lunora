import emit from "../../finding";
import type { Lint } from "../../types";
import { callSiteFields, functionKeysOf, queryReadLocation, scheduledFunctionKeys, writesRowsReadBy } from "../helpers";

/** The comparators that bound an index range from above. A range without one reads from its lower end to the end of the index. */
const UPPER_BOUNDS: ReadonlySet<string> = new Set(["lt", "lte"]);

/**
 * Flags a `.withIndex(…).collect()` whose index range has no upper bound, when the
 * read runs from the server (an internal procedure, or one a call edge schedules)
 * and nothing in the same function removes the rows it selects.
 *
 * Each run of such a sweep reads the whole open range again. The rows it found on
 * the last run are still there, so the next run selects them too, and the work
 * grows with the table. A range is open when its callback calls no `lt`/`lte`: an
 * `eq` alone is a partition with no upper edge, and so is a lone `gt`.
 *
 * A `.take(n)` or `.paginate(…)` ends the chain in another terminal, so this rule
 * never sees those reads. A `.collect()` with no index at all is `unbounded_collect`'s.
 *
 * Runs only when the codegen feeder supplied reads (`context.queries` present);
 * a runtime caller supplies none and so flags nothing.
 */
const unboundedCollectOnOpenRange: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A server-driven function (an internal procedure, or one a scheduled dispatch runs) calls `.collect()` on an open index range, with no upper bound and no take/paginate, and nothing in the same function removes the rows it selects. Each run reads the whole range again, and the cost grows with the table.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "unbounded_collect_on_open_range",
    remediation:
        "Bound the range from above (`.withIndex(…, (q) => q.eq(…).lt(…, cutoff))`), cap it with `.take(n)`, or page it with `.paginate(…)` and carry the cursor to the next run. A sweep that never removes the rows it selects keeps selecting them, so delete or update the rows it has handled, or move the cursor past them.",
    run: (context) => {
        const scheduled = scheduledFunctionKeys(context.callEdges, context.cronTargets);
        const findings = [];

        for (const read of context.queries ?? []) {
            // Only a named `withIndex` range we can read the bounds of. A search or geo index is
            // not a range, and an unreadable callback is no evidence of an open range.
            if (read.terminal !== "collect" || read.table === "" || read.indexName === undefined || read.indexBounds === undefined) {
                continue;
            }

            if (read.indexBounds.some((bound) => UPPER_BOUNDS.has(bound))) {
                continue;
            }

            const serverDriven = read.visibility === "internal" || functionKeysOf(read.file, read.scope).some((key) => scheduled.has(key));

            if (!serverDriven || writesRowsReadBy(context.tableWrites, read)) {
                continue;
            }

            findings.push(
                emit(unboundedCollectOnOpenRange, {
                    cacheKey: `unbounded_collect_on_open_range:${read.file}:${read.line.toString()}:${read.table}`,
                    detail: `Server-driven read of "${read.table}" at ${queryReadLocation(read)} collects the open range of index "${read.indexName}" with no upper bound. Nothing in the same function removes the rows it selects, so every run reads the whole range again.`,
                    metadata: { ...callSiteFields(read), indexName: read.indexName, table: read.table },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Unbounded collect on an open index range",
};

export default unboundedCollectOnOpenRange;
