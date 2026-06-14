import emit from "../../finding";
import type { Finding, Lint } from "../../types";

/**
 * Detect FK cycles in the declared relation graph via a DFS.
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
 * Each cycle is reported once: the cycle path is canonicalized to its
 * lexicographically smallest rotation so two DFS traversals that enter the
 * same ring at different nodes emit the same cacheKey and detail.
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

        // Build adjacency map: table → tables it references via `one` relations.
        // Each entry maps the source table name to the set of targets it points at.
        const edges = new Map<string, Set<string>>();

        for (const table of context.schema.tables) {
            for (const relation of table.relations) {
                if (relation.kind !== "one") {
                    continue;
                }

                let targets = edges.get(table.name);

                if (targets === undefined) {
                    targets = new Set();
                    edges.set(table.name, targets);
                }

                targets.add(relation.table);
            }
        }

        // DFS cycle detection. `visited` tracks all nodes seen in the current
        // run; `stack` tracks nodes on the current DFS path (to detect back
        // edges). `reported` deduplicates cycles by their canonical form.
        const visited = new Set<string>();
        const reported = new Set<string>();

        /**
         * Walk the relation graph from `node`, collecting the current path in
         * `path`. When a back edge is found, extract + canonicalize the cycle
         * and emit exactly one finding per unique cycle.
         */
        const dfs = (node: string, path: string[]): void => {
            if (visited.has(node)) {
                return;
            }

            visited.add(node);
            path.push(node);

            for (const neighbor of edges.get(node) ?? []) {
                const cycleStart = path.indexOf(neighbor);

                if (cycleStart === -1) {
                    dfs(neighbor, path);
                } else {
                    // Extract the cycle: path[cycleStart..] closes back to neighbor.
                    const cycle = path.slice(cycleStart);

                    // Canonicalize: rotate to the lexicographically smallest
                    // start node so the same ring entered at different points
                    // produces the same key regardless of DFS traversal order.
                    let minIndex = 0;

                    for (let i = 1; i < cycle.length; i += 1) {
                        if ((cycle[i] as string) < (cycle[minIndex] as string)) {
                            minIndex = i;
                        }
                    }

                    const canonical = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
                    const key = canonical.join("→");

                    if (!reported.has(key)) {
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
                    }
                }
            }

            path.pop();
        };

        for (const table of context.schema.tables) {
            dfs(table.name, []);
        }

        return findings;
    },
    source: "static",
    title: "Circular foreign-key dependency",
};

export default circularFk;
