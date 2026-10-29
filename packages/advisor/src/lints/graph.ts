/**
 * Tarjan's strongly-connected components over a dispatch graph — every cluster of
 * nodes that can reach each other. Each edge inside a component lies on some cycle,
 * so a component of two or more, or one with a self-edge, is a loop. Shared by the
 * `dispatch_cycle` and `queue_dispatch_cycle` lints.
 */
const stronglyConnected = (nodes: ReadonlyArray<string>, successors: ReadonlyMap<string, ReadonlyArray<string>>): string[][] => {
    // Per node: its DFS discovery order and the lowest order reachable from it.
    const visited = new Map<string, { index: number; lowLink: number }>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];

    const visit = (node: string): { index: number; lowLink: number } => {
        const state = { index: visited.size, lowLink: visited.size };

        visited.set(node, state);
        stack.push(node);
        onStack.add(node);

        for (const next of successors.get(node) ?? []) {
            const seen = visited.get(next);

            if (seen === undefined) {
                state.lowLink = Math.min(state.lowLink, visit(next).lowLink);
            } else if (onStack.has(next)) {
                state.lowLink = Math.min(state.lowLink, seen.index);
            }
        }

        if (state.lowLink === state.index) {
            const component: string[] = [];

            for (let member = stack.pop(); member !== undefined; member = member === node ? undefined : stack.pop()) {
                onStack.delete(member);
                component.push(member);
            }

            components.push(component);
        }

        return state;
    };

    for (const node of nodes) {
        if (!visited.has(node)) {
            visit(node);
        }
    }

    return components;
};

export default stronglyConnected;
