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
 * A single-table self-reference (`A.parentId → A`) is **not** reported: a
 * self-referential FK is the canonical, intentional shape for trees/hierarchies
 * (categories, org charts, threaded comments), so flagging every such schema
 * would be noise. Only multi-table cycles — the ones the description illustrates
 * — are surfaced.
 *
 * Each unique cycle is reported once: the cycle path is canonicalized to its
 * lexicographically smallest rotation so two DFS traversals that enter the same
 * ring at different nodes emit the same cacheKey and detail. A representative
 * cycle is reported for each distinct simple cycle in the graph; overlapping or
 * chord cycles that share interior nodes are each detected independently.
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

        // DFS cycle detection. `onStack` tracks nodes on the current DFS path
        // (used as an O(1) back-edge test); `path` is the ordered path list
        // used to extract the cycle slice. `reported` deduplicates found cycles
        // by their canonical form.
        //
        // There is intentionally NO global `visited` set that would mark a node
        // as permanently done after the first DFS visit. Such a set would
        // prevent the algorithm from re-entering a node that is an interior node
        // of two different cycles (overlapping / chord cycles), causing the
        // second cycle to be silently dropped. Instead, redundant subtree work
        // is bounded by the `reported` set (a known cycle is not re-emitted) and
        // by the `onStack` guard (a neighbor already on the current path is a
        // back edge, not a recursive descent).
        const onStack = new Set<string>();
        const reported = new Set<string>();

        /**
         * A back edge `… → neighbor` was found while `neighbor` is on the current
         * path. Extract the ring `path[cycleStart..]`, canonicalize it to its
         * lexicographically smallest rotation (so the same ring entered at
         * different nodes produces one key/finding), and emit it once.
         */
        const reportBackEdge = (neighbor: string, path: ReadonlyArray<string>): void => {
            const cycleStart = path.indexOf(neighbor);

            // `neighbor` is on the stack, so it is always in `path` — the guard is
            // defensive only.
            if (cycleStart === -1) {
                return;
            }

            const cycle = path.slice(cycleStart);

            // A single-node "cycle" is a self-referential FK (`A.parentId → A`) —
            // the intentional tree/hierarchy shape, not the multi-table delete
            // hazard this lint targets. Skip it.
            if (cycle.length < 2) {
                return;
            }

            // Canonicalize: rotate to the lexicographically smallest start node.
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
        };

        /**
         * Walk the relation graph from `node`, collecting the current path in
         * `path` / `onStack`. A neighbor already on the path is a back edge
         * (handled by {@link reportBackEdge}); any other neighbor is descended into.
         */
        const dfs = (node: string, path: string[]): void => {
            onStack.add(node);
            path.push(node);

            for (const neighbor of edges.get(node) ?? []) {
                if (onStack.has(neighbor)) {
                    reportBackEdge(neighbor, path);
                } else {
                    dfs(neighbor, path);
                }
            }

            path.pop();
            onStack.delete(node);
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
