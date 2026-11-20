/**
 * The three detectors run together over one parsed module: one walk collects
 * every candidate, and only those the attribution filter keeps are analysed.
 */
import { alarmFindings, alarmHandlerOf, isSetAlarmCall } from "./scan-alarms.mjs";
import { hasExit, isAlwaysOnLoop, loopKindOf, yieldsFromLoop } from "./scan-loops.mjs";
import { isSendCall, queueFindings, queueHandlerOf, selfFeedingBindings } from "./scan-queues.mjs";
import { positionOf, walk } from "./scan-tree.mjs";

/** @typedef {import("./scan-tree.mjs").AstNode} AstNode */
/** @typedef {import("./scan-tree.mjs").Tree} Tree */

/**
 * One raw finding, before attribution: where in the bundle, and what.
 * @typedef {{ binding?: string, column: number, delayMs?: number, level?: "INFO" | "WARN", line: number, loopKind?: string, name: string, queue?: string }} RawFinding
 */

/**
 * The candidates of each detector, collected in one walk.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} program The module.
 * @returns {{ alarms: AstNode[], loops: AstNode[], queues: NonNullable<ReturnType<typeof queueHandlerOf>>[] }} The candidates.
 */
const candidatesOf = (tree, program) => {
    const loops = [];
    const alarms = [];
    const queues = [];

    walk(tree, program, (node) => {
        const handler = queueHandlerOf(node);
        const alarm = alarmHandlerOf(node);

        if (isAlwaysOnLoop(node)) {
            loops.push(node);
        } else if (alarm !== undefined) {
            alarms.push(alarm);
        } else if (handler !== undefined) {
            queues.push(handler);
        }
    });

    return { alarms, loops, queues };
};

/**
 * Find every raw finding in a parsed module.
 *
 * Two passes: one walk collects the candidates (cheap), `keep` drops those the
 * tenant cannot act on (dependency code), and only the survivors get the
 * per-candidate analyses — so third-party loops never spend the time budget.
 * @param {Tree} tree The parsed module's tree.
 * @param {AstNode} program The module.
 * @param {{ keep: (position: { column: number, line: number }) => boolean, manifest?: unknown }} options Attribution filter and the release manifest.
 * @returns {RawFinding[]} The findings.
 */
const detect = (tree, program, { keep, manifest }) => {
    const { alarms, loops, queues } = candidatesOf(tree, program);
    const kept = (node) => keep(node.loc.start);
    const selfFeeding = selfFeedingBindings(manifest);

    return [
        ...loops
            .filter((loop) => kept(loop) && !hasExit(tree, loop) && !yieldsFromLoop(tree, loop))
            .map((loop) => {
                return { ...positionOf(loop), loopKind: loopKindOf(loop), name: "unbounded_loop" };
            }),
        ...alarms.filter((handler) => kept(handler)).flatMap((handler) => alarmFindings(tree, handler)),
        ...(selfFeeding.size === 0 ? [] : queues.filter((handler) => kept(handler.fn)).flatMap((handler) => queueFindings(tree, handler, selfFeeding))),
    ];
};

/**
 * The bundle line a candidate is attributed at — the sourcemap pass keeps only these.
 * @param {AstNode} node An ESTree node.
 * @returns {number | undefined} Its line, when it is a candidate (or a site in one).
 */
const candidateLine = (node) => {
    if (isAlwaysOnLoop(node) || isSetAlarmCall(node) || isSendCall(node)) {
        return node.loc.start.line;
    }

    return (alarmHandlerOf(node) ?? queueHandlerOf(node)?.fn)?.loc.start.line;
};

export { candidateLine, detect };
