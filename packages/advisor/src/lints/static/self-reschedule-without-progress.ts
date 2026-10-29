import type { AdvisorCallEdge } from "../../call-edges";
import { callSiteCallers } from "../../call-site-scope";
import emit from "../../finding";
import type { Lint, LintContext } from "../../types";
import type { RowChanges } from "../helpers";
import { functionKey, readRowsChanged, rowChangesOf } from "../helpers";

/** A delay under this many milliseconds re-runs the function before a previous run's work could have settled. */
const SHORT_DELAY_MS = 1000;

/**
 * A delay from {@link SHORT_DELAY_MS} up to this many milliseconds is a poll: it re-runs on a
 * steady cadence, and every run is billed for the reads and writes it makes.
 */
const POLL_DELAY_MS = 60_000;

/** Writes that rewrite a row in place. On a poll's every tick they are the cost, so they are not progress there. */
const REWRITE_METHODS: ReadonlySet<string> = new Set(["patch", "patchIf", "patchMany", "patchWhere"]);

/** The same row changes with every rewrite dropped, so only a removal can count as progress. */
const withoutRewrites = (changes: RowChanges): RowChanges =>
    new Map([...changes].map(([key, list]) => [key, list.filter((change) => !REWRITE_METHODS.has(change.method))]));

/**
 * A dispatch arg that carries progress from one run to the next: `cursor`, `continueCursor`,
 * `nextCursor`, `pageCursor`, or the snake-case forms. `resetCursor` and `cursorX` do not match.
 */
const CURSOR_KEY = /^(?:continue|next|page)?_?cursor$/iu;

/** The export a conditional, static self-dispatch re-arms, or `undefined` for any other edge. */
const selfRearmName = (edge: AdvisorCallEdge): string | undefined => {
    if (edge.kind !== "schedule" || edge.conditional !== true || edge.target === undefined || edge.scope.kind !== "export") {
        return undefined;
    }

    return edge.target === functionKey(edge.file, edge.scope.name) ? edge.scope.name : undefined;
};

/**
 * The literal delay of a re-arm worth judging: under a minute, with an args object that
 * is readable and carries no cursor key. `undefined` otherwise, so the edge is skipped.
 */
const judgeableDelay = (edge: AdvisorCallEdge): number | undefined => {
    const delayMs = edge.schedule?.delayMs;
    const argumentKeys = edge.schedule?.argKeys;

    if (delayMs === undefined || delayMs >= POLL_DELAY_MS || argumentKeys === undefined || argumentKeys.some((key) => CURSOR_KEY.test(key))) {
        return undefined;
    }

    return delayMs;
};

/** A function that calls out to another function may make its progress there. */
const callsOut = (callEdges: ReadonlyArray<AdvisorCallEdge>, file: string, name: string): boolean =>
    callEdges.some((other) => other.kind === "call" && other.file === file && other.scope.kind === "export" && other.scope.name === name);

/**
 * Whether a run of `name` removes, or cannot be shown to leave alone, the rows it reads:
 * true when it reads nothing (nothing is re-read) or a change clears one of its reads.
 */
const clearsARead = (context: LintContext, file: string, name: string, changes: RowChanges): boolean => {
    const selected = (context.queries ?? []).filter((read) => read.file === file && read.table !== "" && callSiteCallers(read.scope).includes(name));

    return selected.length === 0 || selected.some((read) => readRowsChanged(changes, read, undefined, [name]));
};

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
 *
 * Two bands. Under {@link SHORT_DELAY_MS} is a spin (WARN): any row change counts as
 * progress. From there up to {@link POLL_DELAY_MS} is a poll (INFO): a rewrite of a row
 * on every tick is not progress, so only a removal clears it. Longer is left alone.
 *
 * Runs only when the codegen feeder supplied call edges (`context.callEdges` present).
 */
const selfRescheduleWithoutProgress: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A function re-arms itself with `ctx.scheduler.runAfter` on a delay under a minute, and the re-arming passes no cursor and nothing in the function removes the rows it reads. Each run finds the same rows and does the same work again; a delay under a second is a spin, and a longer one is a poll that rewrites a row on every tick.",
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
            const name = selfRearmName(edge);
            const delayMs = judgeableDelay(edge);

            if (name === undefined || delayMs === undefined) {
                continue;
            }

            const poll = delayMs >= SHORT_DELAY_MS;

            if (callsOut(callEdges, edge.file, name) || clearsARead(context, edge.file, name, poll ? withoutRewrites(changes) : changes)) {
                continue;
            }

            findings.push(
                emit(selfRescheduleWithoutProgress, {
                    cacheKey: `self_reschedule_without_progress:${edge.file}:${edge.line.toString()}:${name}`,
                    detail: poll
                        ? `\`${name}\` (${edge.file}:${edge.line.toString()}) polls itself every ${delayMs.toString()} ms with no cursor in its args, and it removes none of the rows it reads. Each tick re-reads the same rows and rewrites in place, and each run is billed.`
                        : `\`${name}\` (${edge.file}:${edge.line.toString()}) re-arms itself after ${delayMs.toString()} ms with no cursor in its args, and it removes none of the rows it reads. The next run finds the same rows and starts the same work again.`,
                    level: poll ? "INFO" : "WARN",
                    metadata: { delayMs, file: edge.file, function: name, line: edge.line, tier: poll ? "poll" : "spin" },
                }),
            );
        }

        return findings;
    },
    source: "static",
    title: "Self-reschedule without progress",
};

export default selfRescheduleWithoutProgress;
