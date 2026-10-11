import { sanitizeNamespace } from "../../../../../shared/dispatch-namespace";
import { callSiteCallers } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";
import { writesRowsReadBy } from "../helpers";

/** A delay under this many milliseconds re-runs the function before a previous run's work could have settled. */
const SHORT_DELAY_MS = 1000;

/**
 * Flags a function that re-arms itself on a short literal delay (`runAfter(…, self)`)
 * when the re-arming carries no progress: no cursor in its args, and nothing in the
 * function removes the rows it selects. The next run finds the same rows and starts
 * the same work again, as often as the delay allows.
 *
 * An unconditional self-dispatch is `dispatch_cycle`'s, which already reports it as
 * an error. This rule takes only the conditional ones, so each site gets one finding.
 * A longer delay is left alone: it is a poll, not a spin.
 *
 * A cursor is read off the dispatch's args by name, so a cursor carried in a
 * differently named variable is missed, and the finding is then a false positive
 * the author can dismiss. The rule does not reason about whether the sweep ever
 * terminates; a sweep with no short delay is not in its scope.
 *
 * Runs only when the codegen feeder supplied call edges (`context.callEdges` present).
 */
const selfRescheduleWithoutProgress: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A function re-arms itself with `ctx.scheduler.runAfter` on a delay under one second, and the re-arming passes no cursor and nothing in the function removes the rows it selects. Each run finds the same rows and does the same work again.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "self_reschedule_without_progress",
    remediation:
        "Carry the progress forward: pass a cursor (or the last processed id) in the dispatch args, or delete or update the rows the function handled so the next run selects only what is left. Re-arm only while work remains, and use a longer delay or a `cron` for periodic work.",
    run: (context) => {
        if (context.callEdges === undefined) {
            return [];
        }

        const findings = [];

        for (const edge of context.callEdges) {
            if (edge.kind !== "schedule" || edge.conditional !== true || edge.target === undefined || edge.scope.kind !== "export") {
                continue;
            }

            const { name } = edge.scope;

            if (edge.target !== `${sanitizeNamespace(edge.file)}:${name}`) {
                continue;
            }

            if (edge.delayMs === undefined || edge.delayMs >= SHORT_DELAY_MS || edge.passesCursor === true) {
                continue;
            }

            // A function that removes a row it also selects is making progress, so it is not spinning.
            const selected = (context.queries ?? []).filter(
                (read) => read.file === edge.file && read.table !== "" && callSiteCallers(read.scope).includes(name),
            );

            if (selected.some((read) => writesRowsReadBy(context.tableWrites, read))) {
                continue;
            }

            findings.push(
                emit(selfRescheduleWithoutProgress, {
                    cacheKey: `self_reschedule_without_progress:${edge.file}:${edge.line.toString()}:${name}`,
                    detail: `\`${name}\` (${edge.file}:${edge.line.toString()}) re-arms itself after ${edge.delayMs.toString()} ms with no cursor in its args, and it removes none of the rows it selects. The next run finds the same rows and starts the same work again.`,
                    metadata: { delayMs: edge.delayMs, file: edge.file, function: name, line: edge.line },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Self-reschedule without progress",
};

export default selfRescheduleWithoutProgress;
