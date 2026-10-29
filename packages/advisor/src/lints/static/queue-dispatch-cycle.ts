import { sanitizeNamespace } from "../../../../../shared/dispatch-namespace";
import type { AdvisorCallEdge } from "../../call-edges";
import emit from "../../finding";
import type { AdvisorQueue } from "../../queues";
import type { Lint, LintContext } from "../../types";
import stronglyConnected from "../graph";

/** One unconditional hop of the queue graph: a call, a schedule, an enqueue, a publish, or a subscription delivery. */
interface QueueHop {
    file: string;
    from: string;
    kind: "call" | "enqueue" | "publish" | "schedule" | "subscribe";
    line: number;
    to: string;
}

const queueNode = (exportName: string): string => `queue:${exportName}`;
const topicNode = (exportName: string): string => `topic:${exportName}`;

/**
 * Where a function key that IS a queue consumer resolves to the queue's node: the
 * handler's own export (`queues:emailQueue` for an inline handler), and a handler
 * passed by reference (`handler: processEmail` exported from another file). A
 * consumer's call sites are attributed to its export, so they start from the queue.
 */
const consumerNodes = (queues: ReadonlyArray<AdvisorQueue>): Map<string, string> => {
    const nodes = new Map<string, string>();

    for (const queue of queues) {
        if (queue.filePath !== undefined) {
            nodes.set(`${sanitizeNamespace(queue.filePath)}:${queue.exportName}`, queueNode(queue.exportName));
        }

        if (queue.handlerSite !== undefined) {
            nodes.set(`${sanitizeNamespace(queue.handlerSite.file)}:${queue.handlerSite.exportName}`, queueNode(queue.exportName));
        }
    }

    return nodes;
};

/**
 * The graph hop one call edge draws, or `undefined` when its target is not a node the
 * graph knows: a queue or topic the feeder declares, or a function a consumer resolves to.
 * `call` and `schedule` hops point at a function; `enqueue` and `publish` at a queue or topic.
 */
const edgeHop = (
    edge: AdvisorCallEdge,
    target: string,
    consumers: ReadonlyMap<string, string>,
    queueNames: ReadonlySet<string>,
    topicNames: ReadonlySet<string>,
): QueueHop | undefined => {
    const own = `${sanitizeNamespace(edge.file)}:${edge.scope.kind === "export" ? edge.scope.name : ""}`;
    const from = consumers.get(own) ?? own;

    switch (edge.kind) {
        case "call":
        case "schedule": {
            return { file: edge.file, from, kind: edge.kind, line: edge.line, to: consumers.get(target) ?? target };
        }
        case "enqueue": {
            return queueNames.has(target) ? { file: edge.file, from, kind: "enqueue", line: edge.line, to: queueNode(target) } : undefined;
        }
        case "publish": {
            return topicNames.has(target) ? { file: edge.file, from, kind: "publish", line: edge.line, to: topicNode(target) } : undefined;
        }
        default: {
            return undefined;
        }
    }
};

/**
 * The queue-graph hops a set of call edges draws. A hop is kept only when nothing may
 * stop it, so a `conditional` edge is dropped unless a loop body is its only guard
 * (`loopOnly`): a batch loop over `batch.messages` runs once per message, which is a
 * reason to flag the hop, not a reason to clear it. A helper's site is dropped, as in
 * `dispatch_cycle`, because its call may sit behind a guard in its caller.
 */
const hopsOf = (edges: ReadonlyArray<AdvisorCallEdge>, queues: ReadonlyArray<AdvisorQueue>): QueueHop[] => {
    const consumers = consumerNodes(queues);
    const queueNames = new Set(queues.map((queue) => queue.exportName));
    const topicNames = new Set(queues.flatMap((queue) => (queue.topic === undefined ? [] : [queue.topic])));
    const hops: QueueHop[] = [];

    for (const edge of edges) {
        const hop =
            edge.target === undefined || edge.scope.kind !== "export" || (edge.conditional === true && edge.loopOnly !== true)
                ? undefined
                : edgeHop(edge, edge.target, consumers, queueNames, topicNames);

        if (hop !== undefined) {
            hops.push(hop);
        }
    }

    for (const queue of queues) {
        if (queue.topic !== undefined) {
            hops.push({ file: queue.filePath ?? "", from: topicNode(queue.topic), kind: "subscribe", line: 0, to: queueNode(queue.exportName) });
        }
    }

    return hops;
};

const VERB: Readonly<Record<QueueHop["kind"], string>> = {
    call: "calls",
    enqueue: "enqueues to",
    publish: "publishes to",
    schedule: "schedules",
    subscribe: "delivers to",
};

/**
 * Flags a cycle through a queue or a topic in which every hop runs unconditionally: a
 * queue consumer that (directly, or through a function it runs) sends back to its own
 * queue, or a topic whose subscriber leads back to a publish. Each message handled then
 * produces another, so the queue never drains, and every delivery is billed.
 *
 * The cycle is built from the same call-site edges `dispatch_cycle` reads, plus the
 * enqueue, publish and subscription edges it ignores. A queue consumer is a node: its
 * call sites start from the queue, and its handler's batch loop counts as a loop, not a
 * guard. A cycle with no queue or topic node is `dispatch_cycle`'s, so this lint reports
 * only the components that include one.
 *
 * Runs only when the codegen feeder supplied call edges and queues; a runtime caller flags nothing.
 */
const queueDispatchCycle: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A queue consumer, or a function it runs, sends back to its own queue (directly or through a topic a subscriber publishes to), on every message it handles. Each message produces another, so the queue never drains.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "queue_dispatch_cycle",
    remediation:
        "Stop the re-enqueue behind a condition: send again only while work remains, carry an attempt count in the message body and stop at a cap, or route the failure to the queue's dead-letter queue instead of back into the same one.",
    run: (context: LintContext) => {
        if (context.callEdges === undefined || context.queues === undefined) {
            return [];
        }

        const hops = hopsOf(context.callEdges, context.queues);
        const successors = new Map<string, string[]>();

        for (const hop of hops) {
            const targets = successors.get(hop.from);

            if (targets === undefined) {
                successors.set(hop.from, [hop.to]);
            } else {
                targets.push(hop.to);
            }
        }

        return stronglyConnected(
            [...successors.keys()].toSorted((a, b) => a.localeCompare(b)),
            successors,
        ).flatMap((component) => {
            const members = new Set(component);
            const throughQueue = component.some((node) => node.startsWith("queue:") || node.startsWith("topic:"));
            const inside = hops
                .filter((hop) => members.has(hop.from) && members.has(hop.to))
                .toSorted((a, b) => a.from.localeCompare(b.from) || a.file.localeCompare(b.file) || a.line - b.line);

            if (!throughQueue || inside.length === 0) {
                return [];
            }

            const sorted = component.toSorted((a, b) => a.localeCompare(b));
            const described = inside.map((hop) => `\`${hop.from}\` ${VERB[hop.kind]} \`${hop.to}\` (${hop.file}:${hop.line.toString()})`);

            return [
                emit(queueDispatchCycle, {
                    cacheKey: `queue_dispatch_cycle:${sorted.join(",")}`,
                    detail: `Unconditional queue cycle: ${described.join("; ")}. No \`if\`, \`try\`, or early return stands in front of any hop, so once one of these runs the chain never stops.`,
                    metadata: {
                        hops: inside.map((hop) => {
                            return { file: hop.file, from: hop.from, kind: hop.kind, line: hop.line, to: hop.to };
                        }),
                        nodes: sorted,
                    },
                }),
            ];
        });
    },
    source: "static",
    title: "Endless queue cycle",
};

export default queueDispatchCycle;
