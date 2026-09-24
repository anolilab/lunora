import emit from "../../finding";
import type { Finding, Lint } from "../../types";

/**
 * Upper bound on the number of distinct FK cycles reported in a single run.
 * Johnson's algorithm enumerates elementary circuits in `O((V + E)(C + 1))`
 * time, so a densely interconnected FK graph can hold a combinatorial number of
 * cycles; capping keeps both the advisor output and its runtime bounded. A
 * schema with this many FK cycles has a systemic modeling problem the first
 * handful of findings already surface.
 */
const MAX_CYCLES = 100;

/**
 * Detect FK cycles in the declared relation graph.
 *
 * A "circular FK" exists when a chain of `one` relations forms a loop — for
 * example `A.authorId → B`, `B.ownerId → C`, `C.postId → A`. Such cycles can
 * cause unexpected behavior during DELETE operations: a CASCADE chain may loop
 * forever (or deadlock), and even a RESTRICT cycle prevents deletion of any row
 * in the loop without temporarily disabling constraints.
 *
 * Only `one` relations are followed because they are the side that owns the FK
 * column (the `field` lives on the holding table). `many` relations point back
 * to the same edge from the opposite side and would cause every edge to be
 * double-counted; skipping them gives the correct directed graph.
 *
 * A single-table self-reference (`A.parentId → A`) is **not** reported: a
 * self-referential FK is the canonical, intentional shape for trees/hierarchies
 * (categories, org charts, threaded comments), so flagging every such schema
 * would be noise. Only multi-table cycles — the ones the description illustrates
 * — are surfaced.
 *
 * Cycle enumeration uses **Johnson's algorithm** rather than a naive
 * enumerate-all-paths DFS. A plain path-DFS re-walks every simple path in the
 * graph, which is worst-case exponential even on a fully **acyclic** schema
 * (reconverging FK fan-out — many tables referencing shared parents in a chain —
 * makes codegen appear to hang). Johnson blocks a vertex once a fruitless
 * subtree is exhausted and only unblocks it when a new cycle through it is
 * found, so it runs in `O((V + E)(C + 1))` for `C` elementary circuits — no
 * blowup on acyclic input. Each circuit is enumerated exactly once from its
 * lowest-indexed member (vertices are ordered lexicographically), so overlapping
 * / chord cycles that share interior nodes are each detected independently. The
 * emitted cycle is then canonicalized to its lexicographically smallest rotation
 * for a stable cacheKey: the search order is locale-collated (`localeCompare`)
 * while the rotation compares by codepoint, and the two disagree on mixed-case
 * table names — so the rotation, not the start vertex, is what pins the cacheKey
 * across ICU builds.
 */
const circularFk: Lint = {
    categories: ["SCHEMA"],
    description:
        "A chain of foreign-key relations forms a cycle (e.g. A → B → C → A). Circular FK dependencies can cause unexpected behavior during DELETE operations — a CASCADE chain may loop indefinitely, and even a RESTRICT cycle prevents deletion of any row in the loop without temporarily disabling constraints.",
    facing: "INTERNAL",
    level: "WARN",
    name: "circular_fk",
    remediation:
        "Remove or break the cycle by dropping at least one FK relation from the loop. Consider replacing the circular dependency with a nullable FK and explicit application logic, or restructure the schema using a junction table.",
    run: (context) => {
        const findings: Finding[] = [];

        // Order tables lexicographically so Johnson's algorithm can restrict each
        // circuit search to vertices >= the start vertex, finding every
        // elementary circuit exactly once from its lowest-indexed member. The lex
        // order also makes the lowest-indexed member the canonical smallest start.
        const order = [...new Set(context.schema.tables.map((table) => table.name))].toSorted((left, right) => left.localeCompare(right));
        const indexOf = new Map(order.map((name, index) => [name, index]));

        // Build adjacency map: table → tables it references via `one` relations.
        // Only edges to a known table participate — a relation to an undeclared
        // target can never close a cycle (handled by the `*_unknown_table` lint).
        const adjacency = new Map<string, Set<string>>();

        for (const table of context.schema.tables) {
            for (const relation of table.relations) {
                if (relation.kind !== "one" || !indexOf.has(relation.table)) {
                    continue;
                }

                let targets = adjacency.get(table.name);

                if (targets === undefined) {
                    targets = new Set();
                    adjacency.set(table.name, targets);
                }

                targets.add(relation.table);
            }
        }

        // Johnson's algorithm state. `blocked` marks vertices that cannot yield a
        // fresh circuit on the current path; `blockMap` records, for a blocked
        // vertex, which predecessors to unblock when it is unblocked. `stack` is
        // the current circuit path; `reported` dedups emitted cycles by canonical
        // key.
        const blocked = new Set<string>();
        const blockMap = new Map<string, Set<string>>();
        const stack: string[] = [];
        const reported = new Set<string>();
        let capped = false;

        const unblock = (vertex: string): void => {
            blocked.delete(vertex);
            const dependents = blockMap.get(vertex);

            if (dependents === undefined) {
                return;
            }

            for (const dependent of dependents) {
                dependents.delete(dependent);

                if (blocked.has(dependent)) {
                    unblock(dependent);
                }
            }
        };

        /**
         * Emit the circuit currently on `stack` (which begins and conceptually
         * closes at its first vertex). Canonicalize it to its lexicographically
         * smallest rotation so the same ring produces one stable cacheKey, skip a
         * single-node self-loop (intentional tree shape), and emit once.
         */
        const emitCurrentCycle = (): void => {
            const cycle = [...stack];

            // A single-node "cycle" is a self-referential FK (`A.parentId → A`) —
            // the intentional tree/hierarchy shape, not the multi-table delete
            // hazard this lint targets. Skip it.
            if (cycle.length < 2) {
                return;
            }

            let minIndex = 0;

            for (let index = 1; index < cycle.length; index += 1) {
                if ((cycle[index] as string) < (cycle[minIndex] as string)) {
                    minIndex = index;
                }
            }

            const canonical = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
            const key = canonical.join("→");

            if (reported.has(key)) {
                return;
            }

            reported.add(key);

            const displayPath = [...canonical, canonical[0] as string].join(" → ");

            findings.push(
                emit(circularFk, {
                    cacheKey: `circular_fk:${key}`,
                    detail: `Circular foreign-key dependency detected: ${displayPath}. This cycle can cause unexpected behavior during DELETE operations.`,
                    metadata: {
                        cycle: canonical,
                        path: displayPath,
                        tables: canonical,
                    },
                }),
            );

            if (reported.size >= MAX_CYCLES) {
                capped = true;
            }
        };

        /** `vertex`'s neighbors restricted to the current subgraph (index >= `startIndex`). */
        const subgraphNeighbors = (vertex: string, startIndex: number): string[] =>
            [...(adjacency.get(vertex) ?? [])].filter((neighbor) => (indexOf.get(neighbor) as number) >= startIndex);

        /**
         * Record `vertex` as a dependent of each in-subgraph neighbor, so it is
         * unblocked only when one of them later participates in a circuit.
         */
        const blockOnNeighbors = (vertex: string, startIndex: number): void => {
            for (const neighbor of subgraphNeighbors(vertex, startIndex)) {
                let dependents = blockMap.get(neighbor);

                if (dependents === undefined) {
                    dependents = new Set();
                    blockMap.set(neighbor, dependents);
                }

                dependents.add(vertex);
            }
        };

        /**
         * Johnson's `CIRCUIT` procedure over the subgraph induced by vertices with
         * index >= `startIndex`. Returns whether a circuit back to `start` was
         * found through `vertex`.
         */
        const circuit = (vertex: string, start: string, startIndex: number): boolean => {
            let foundCycle = false;

            stack.push(vertex);
            blocked.add(vertex);

            for (const neighbor of subgraphNeighbors(vertex, startIndex)) {
                if (capped) {
                    break;
                }

                if (neighbor === start) {
                    emitCurrentCycle();
                    foundCycle = true;
                } else if (!blocked.has(neighbor) && circuit(neighbor, start, startIndex)) {
                    foundCycle = true;
                }
            }

            if (foundCycle) {
                unblock(vertex);
            } else {
                blockOnNeighbors(vertex, startIndex);
            }

            stack.pop();

            return foundCycle;
        };

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `capped` is set inside the `record` closure, which TS's control-flow analysis cannot see, so it narrows to its initializer here. The guard is the cycle cap; dropping it removes the bound.
        for (let startIndex = 0; startIndex < order.length && !capped; startIndex += 1) {
            // Fresh blocking state per start vertex (the subgraph shrinks each step).
            blocked.clear();
            blockMap.clear();

            circuit(order[startIndex] as string, order[startIndex] as string, startIndex);
        }

        return findings;
    },
    source: "static",
    title: "Circular foreign-key dependency",
};

export default circularFk;
