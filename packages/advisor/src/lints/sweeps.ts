import { callSiteCallers } from "../call-site-scope";
import type { AdvisorQueryRead } from "../queries";
import type { LintContext } from "../types";
import { functionKey, indexFieldsLookup, readRowsChanged, rowChangesOf, scheduledFunctionKeys } from "./helpers";

/**
 * The reads that are sweeps: a `.withIndex(…).collect()` on an open range, that the
 * server runs, and that nothing in the same function makes progress on. Shared by
 * `unbounded_collect_on_open_range`, which reports them, and `filter_after_index_scan`,
 * which steps aside for them so a read gets one finding.
 *
 * A range is open when no `lt`/`lte` bounds it. A bare `.withIndex(name)` (no
 * callback) is the widest open range there is. "Server-driven" means an internal
 * procedure, or a function a scheduler edge or a cron job reaches. A range of only
 * `eq` pins one value, so it is a lookup, and it counts only when the server
 * schedules it.
 */
const UPPER_BOUNDS: ReadonlySet<string> = new Set(["lt", "lte"]);

/** The reads of `context` that are sweeps, in the order the feeder reported them. */
export const openRangeSweepReads = (context: LintContext): AdvisorQueryRead[] => {
    const scheduled = scheduledFunctionKeys(context.callEdges, context.cronTargets);
    const changes = rowChangesOf(context.tableWrites, context.rowEffects);
    const indexFieldsOf = indexFieldsLookup(context.schema);

    return (context.queries ?? []).filter((read) => {
        if (read.terminal !== "collect" || read.table === "" || read.index?.bounds === undefined) {
            return false;
        }

        const { bounds } = read.index;

        if (bounds.some((bound) => UPPER_BOUNDS.has(bound))) {
            return false;
        }

        const lookup = bounds.length > 0 && bounds.every((bound) => bound === "eq");
        // A caller is server-driven when a scheduler edge or a cron reaches it, or when the read is internal and not a lookup.
        const serverDriven = (caller: string): boolean => scheduled.has(functionKey(read.file, caller)) || (read.visibility === "internal" && !lookup);
        const indexFields = indexFieldsOf(read);

        // A sweep is a read that some server-driven caller makes no progress on. Another caller's write does not count for it.
        return callSiteCallers(read.scope).some((caller) => serverDriven(caller) && !readRowsChanged(changes, read, indexFields, [caller]));
    });
};

/**
 * The filtered fields a read's index does not cover, minus `_id`: the part a filter
 * can only express by walking the index's rows. `_id` is `filter_on_primary_key`'s.
 */
export const uncoveredFilterFields = (read: Pick<AdvisorQueryRead, "filterFields">, indexFields: ReadonlyArray<string> | undefined): string[] => {
    const covered = new Set(indexFields);

    return (read.filterFields ?? []).filter((field) => field !== "_id" && !covered.has(field));
};
