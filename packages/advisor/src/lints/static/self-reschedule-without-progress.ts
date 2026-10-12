import { callSiteCallers } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint } from "../../types";
import { functionKey, readRowsChanged, rowChangesOf } from "../helpers";

/** A delay under this many milliseconds re-runs the function before a previous run's work could have settled. */
const SHORT_DELAY_MS = 1000;

/**
 * A dispatch arg that carries progress from one run to the next: `cursor`, `continueCursor`,
 * `nextCursor`, `pageCursor`, or the snake-case forms. `resetCursor` and `cursorX` do not match.
 */
const CURSOR_KEY = /^(?:continue|next|page)?_?cursor$/iu;

/**
 * Flags a function that re-arms itself on a short literal delay (`runAfter(…, self)`)
 * when the re-arming carries no progress. The next run would find the same rows and
 * start the same work again, as often as the delay allows.
 *
 * A finding is suppressed when the dispatch carries a cursor arg key (see `CURSOR_KEY`),
 * when the function removes a row it reads, itself or through a function it calls (a
 * delete or replace, or a patch of an index field), when it has no reads at all
 * (nothing is re-read), when it calls out to another function (`ctx.run*`, where the
 * progress may happen and this rule cannot see it), and when the args are not an object
 * literal (no evidence either way, so no finding).
 *
 * An unconditional self-dispatch is `dispatch_cycle`'s, which already reports it as
 * an error. This rule takes only the conditional ones, so each site gets one finding.
 * A longer delay is left alone: it is a poll, not a spin.
 *
 * Runs only when the codegen feeder supplied call edges (`context.callEdges` present).
 */
const selfRescheduleWithoutProgress: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A function re-arms itself with `ctx.scheduler.runAfter` on a delay under one second, and the re-arming passes no cursor and nothing in the function removes the rows it reads. Each run finds the same rows and does the same work again.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "self_reschedule_without_progress",
    remediation:
        "Carry the progress forward: pass a cursor (or the last processed id) in the dispatch args, or delete or update the rows the function handled so the next run selects only what is left. Re-arm only while work remains, and use a longer delay or a `cron` for periodic work.",
    run: (context) => {
        if (context.callEdges === undefined) {
            return [];
        }

        const { callEdges } = context;
        const changes = rowChangesOf(context.tableWrites, context.rowEffects);
        const findings = [];

        for (const edge of callEdges) {
            if (edge.kind !== "schedule" || edge.conditional !== true || edge.target === undefined || edge.scope.kind !== "export") {
                continue;
            }

            const { name } = edge.scope;

            if (edge.target !== functionKey(edge.file, name)) {
                continue;
            }

            const delayMs = edge.schedule?.delayMs;
            const argumentKeys = edge.schedule?.argKeys;

            if (delayMs === undefined || delayMs >= SHORT_DELAY_MS || argumentKeys === undefined || argumentKeys.some((key) => CURSOR_KEY.test(key))) {
                continue;
            }

            // A function that calls out to another function may make its progress there.
            const callsOut = callEdges.some(
                (other) => other.kind === "call" && other.file === edge.file && other.scope.kind === "export" && other.scope.name === name,
            );

            if (callsOut) {
                continue;
            }

            const selected = (context.queries ?? []).filter(
                (read) => read.file === edge.file && read.table !== "" && callSiteCallers(read.scope).includes(name),
            );

            if (selected.length === 0 || selected.some((read) => readRowsChanged(changes, read, undefined, [name]))) {
                continue;
            }

            findings.push(
                emit(selfRescheduleWithoutProgress, {
                    cacheKey: `self_reschedule_without_progress:${edge.file}:${edge.line.toString()}:${name}`,
                    detail: `\`${name}\` (${edge.file}:${edge.line.toString()}) re-arms itself after ${delayMs.toString()} ms with no cursor in its args, and it removes none of the rows it reads. The next run finds the same rows and starts the same work again.`,
                    metadata: { delayMs, file: edge.file, function: name, line: edge.line },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Self-reschedule without progress",
};

export default selfRescheduleWithoutProgress;
