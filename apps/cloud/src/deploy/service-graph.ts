/**
 * The static acyclicity check over a project's declared service bindings.
 *
 * A service binding is a call from one of a project's own Workers to a sibling
 * Worker. Bindings are declared in config, not computed at runtime, so the graph
 * is complete for service-to-service calls and a cycle can be refused before
 * anything is provisioned. The check covers declared service bindings only: a
 * loop through a Durable Object or a queue is outside it.
 *
 * UNWIRED. Nothing calls `findServiceCycle`. It is tied to the `service` rows of
 * `BINDING_SUPPORT` in `provision-contract.ts`: every target rates `service`
 * unsupported today, and the deploy path refuses a service binding before any
 * graph is built. The change that flips a target's `service` row to native must
 * call this on the project's service graph before anything is provisioned, and
 * add the test that proves the refusal. Until then it is kept only for that
 * change, and its tests pin the behaviour it will be wired to.
 *
 * Pure over its input.
 */

const byName = (left: string, right: string): number => left.localeCompare(right);

/** A node on the search path, with the sorted successors it has not yet followed. */
interface PathEntry {
    edges: string[];
    next: number;
    node: string;
}

/**
 * The cycle reached from `root`, searching only nodes not already `finished`. Every node it
 * leaves is added to `finished`. An explicit stack, not recursion: a chain as long as the
 * graph must not depend on the engine's call-stack depth.
 */
const cycleFrom = (root: string, successors: (node: string) => string[], finished: Set<string>): ReadonlyArray<string> | undefined => {
    const onPath = new Set<string>([root]);
    const stack: PathEntry[] = [{ edges: successors(root), next: 0, node: root }];

    while (stack.length > 0) {
        const frame = stack.at(-1);

        if (frame === undefined) {
            break;
        }

        const target = frame.edges.at(frame.next);

        if (target === undefined) {
            // Every successor of this node is explored: it is finished, and off the path.
            stack.pop();
            onPath.delete(frame.node);
            finished.add(frame.node);
            continue;
        }

        frame.next += 1;

        if (onPath.has(target)) {
            const start = stack.findIndex((entry) => entry.node === target);

            return [...stack.slice(start).map((entry) => entry.node), target];
        }

        if (!finished.has(target)) {
            onPath.add(target);
            stack.push({ edges: successors(target), next: 0, node: target });
        }
    }

    return undefined;
};

/**
 * The first cycle in the graph, as the path that closes it: the first node is
 * repeated at the end (`["a", "b", "a"]`), and a self-loop is `["a", "a"]`.
 * `undefined` when the graph is acyclic.
 *
 * `graph` maps each of the project's own Workers to the sibling Workers it binds.
 * An edge to a name the graph does not contain is ignored: that name is a
 * connector or an external leaf, which cannot close a loop back to a Worker here.
 *
 * Nodes and edges are visited in sorted order, so the cycle reported for a given
 * graph is always the same one.
 */
export const findServiceCycle = (graph: ReadonlyMap<string, ReadonlyArray<string>>): ReadonlyArray<string> | undefined => {
    const successors = (node: string): string[] => (graph.get(node) ?? []).filter((name) => graph.has(name)).toSorted(byName);
    const finished = new Set<string>();

    for (const root of [...graph.keys()].toSorted(byName)) {
        if (!finished.has(root)) {
            const cycle = cycleFrom(root, successors, finished);

            if (cycle !== undefined) {
                return cycle;
            }
        }
    }

    return undefined;
};
