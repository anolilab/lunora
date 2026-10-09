import type { AdvisorCallEdge } from "../../call-edges";
import emit from "../../finding";
import type { Lint } from "../../types";
import { dispatchNamespace } from "../helpers";

/** One unconditional `call`/`schedule` edge between two functions, keyed `namespace:export`. */
interface Dispatch {
    file: string;
    from: string;
    kind: "call" | "schedule";
    line: number;
    to: string;
}

/**
 * The edges that run on EVERY pass of their function: a `ctx.run*` call or a
 * scheduler dispatch with a static target, in an export's own body, behind no
 * guard. A helper's site is dropped — the helper's own call may sit behind a
 * guard in its caller, which the site's `conditional` cannot see.
 */
const unconditionalDispatches = (edges: ReadonlyArray<AdvisorCallEdge>): Dispatch[] => {
    const dispatches: Dispatch[] = [];

    for (const edge of edges) {
        if ((edge.kind === "call" || edge.kind === "schedule") && edge.target !== undefined && edge.conditional !== true && edge.scope.kind === "export") {
            dispatches.push({
                file: edge.file,
                from: `${dispatchNamespace(edge.file)}:${edge.scope.name}`,
                kind: edge.kind,
                line: edge.line,
                to: edge.target,
            });
        }
    }

    return dispatches;
};

/**
 * Tarjan's strongly-connected components over the dispatch graph — every
 * cluster of functions that can reach each other. Each edge inside a component
 * lies on some cycle, so a component of two or more, or one with a self-edge,
 * is a loop.
 */
const stronglyConnected = (nodes: ReadonlyArray<string>, successors: ReadonlyMap<string, ReadonlyArray<string>>): string[][] => {
    const index = new Map<string, number>();
    const lowLink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    const visit = (node: string): void => {
        index.set(node, index.size);
        lowLink.set(node, index.get(node) as number);
        stack.push(node);
        onStack.add(node);

        for (const next of successors.get(node) ?? []) {
            if (!index.has(next)) {
                visit(next);
                lowLink.set(node, Math.min(lowLink.get(node) as number, lowLink.get(next) as number));
            } else if (onStack.has(next)) {
                lowLink.set(node, Math.min(lowLink.get(node) as number, index.get(next) as number));
            }
        }

        if (lowLink.get(node) === index.get(node)) {
            const component: string[] = [];

            for (let member = stack.pop(); member !== undefined; member = member === node ? undefined : stack.pop()) {
                onStack.delete(member);
                component.push(member);
            }

            components.push(component);
        }
    };

    for (const node of nodes) {
        if (!index.has(node)) {
            visit(node);
        }
    }

    return components;
};

/** How a finding's detail names one edge: `` `jobs:tick` schedules `jobs:tick` (jobs:12) ``. */
const describeDispatch = (dispatch: Dispatch): string =>
    `\`${dispatch.from}\` ${dispatch.kind === "schedule" ? "schedules" : "calls"} \`${dispatch.to}\` (${dispatch.file}:${dispatch.line.toString()})`;

/**
 * Flags a cycle of function dispatches in which every hop runs unconditionally:
 * a function that always schedules itself (`ctx.scheduler.runAfter(…, self)`),
 * or two that always schedule or call each other. Nothing in such a cycle can
 * stop it — once one member runs, the chain re-arms forever. A self-scheduling
 * alarm loop like this burns storage operations until someone notices the bill.
 *
 * The false-positive gate is the feeder's `conditional` flag: a hop behind an
 * `if`, a loop, a `try`, a `switch` arm, an optional chain, a ternary or logical
 * right operand, an earlier early exit, or inside a nested callback is assumed
 * to stop the cycle, and drops out. Only hops in an export's own body count —
 * a helper's call may be guarded where the helper is called — and only static
 * `api.*` / `internal.*` targets. What remains is a loop the source code itself
 * proves endless, hence `ERROR`.
 *
 * Runs only when the codegen feeder supplied call edges (`context.callEdges`
 * present); a runtime caller flags nothing.
 */
const dispatchCycle: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "Functions dispatch each other (or themselves) in a cycle where every hop is unconditional — no guard, loop, `try`, or early return in front of any of them. Once one of them runs, the chain re-schedules itself forever, and every storage read or write along it is billed on every pass.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "dispatch_cycle",
    remediation:
        "Put a stop condition in front of the re-dispatch: reschedule only while there is work left (`if (remaining > 0) await ctx.scheduler.runAfter(…)`), carry an attempt counter in the args and stop at a cap, or move periodic work to a `cron` instead of a self-rescheduling function.",
    run: (context) => {
        if (context.callEdges === undefined) {
            return [];
        }

        const dispatches = unconditionalDispatches(context.callEdges);
        const successors = new Map<string, string[]>();

        for (const dispatch of dispatches) {
            successors.set(dispatch.from, [...(successors.get(dispatch.from) ?? []), dispatch.to]);
        }

        return stronglyConnected(
            [...successors.keys()].toSorted((a, b) => a.localeCompare(b)),
            successors,
        ).flatMap((component) => {
            const members = new Set(component);
            const hops = dispatches
                .filter((dispatch) => members.has(dispatch.from) && members.has(dispatch.to))
                .toSorted((a, b) => a.from.localeCompare(b.from) || a.file.localeCompare(b.file) || a.line - b.line);

            // A lone function is a cycle only when it dispatches itself.
            if (hops.length === 0) {
                return [];
            }

            const sorted = component.toSorted((a, b) => a.localeCompare(b));

            return [
                emit(dispatchCycle, {
                    cacheKey: `dispatch_cycle:${sorted.join(",")}`,
                    detail: `Unconditional dispatch cycle: ${hops.map((hop) => describeDispatch(hop)).join("; ")}. No guard stands in front of any hop, so once one of these functions runs the chain never stops.`,
                    metadata: {
                        functions: sorted,
                        hops: hops.map((hop) => {
                            return { file: hop.file, from: hop.from, kind: hop.kind, line: hop.line, to: hop.to };
                        }),
                    },
                }),
            ];
        });
    },
    source: "static",
    title: "Endless dispatch cycle",
};

export default dispatchCycle;
