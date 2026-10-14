import emit from "../../finding";
import type { AdvisorShape } from "../../shapes";
import type { Lint } from "../../types";

/**
 * Flags a replication shape whose `table` names a table that does not exist in
 * the schema.
 *
 * `defineShape({ table: "messages", … })` binds a shape to a table by a plain
 * string. A live `subscribeShape("…")` resolves that shape server-side and runs
 * its membership query against the named table — so a typo, a stale name after a
 * rename, or a copy-paste mistake produces a shape that can never resolve a
 * rowset: the subscription seeds empty and then errors at the first flush
 * (`no such table`). This is a definite, build-time-detectable break, so it is
 * an `ERROR` — surfaced before the broken shape ever ships.
 *
 * **Evidence supply**: runs only when the codegen feeder supplies
 * `context.shapes`. A shape whose `table` wasn't a static string literal (no
 * resolvable name) is skipped rather than guessed at, so the lint under-reports
 * rather than raising false alarms.
 */
const shapeUnknownTable: Lint = {
    categories: ["SCHEMA"],
    description:
        "A `defineShape` is bound to a `table` name that does not exist in the schema. The shape can never resolve a rowset — its subscription seeds empty and errors at the first flush.",
    facing: "INTERNAL",
    level: "ERROR",
    name: "shape_unknown_table",
    remediation: "Fix the shape's `table` to a real table name (check for a typo or a table that was renamed/removed).",
    run: (context) => {
        if (context.shapes === undefined) {
            return [];
        }

        const knownTables = new Set(context.schema.tables.map((table) => table.name));

        // No resolvable table literal, or a table that exists → nothing to assert.
        return context.shapes
            .filter((shape): shape is AdvisorShape & { table: string } => shape.table !== undefined && !knownTables.has(shape.table))
            .map((shape) =>
                emit(shapeUnknownTable, {
                    cacheKey: `shape_unknown_table:${shape.exportName}`,
                    detail: `Shape \`${shape.exportName}\` (${shape.file}) replicates from table \`${shape.table}\`, which is not declared in the schema. The shape can never resolve a rowset.`,
                    metadata: { exportName: shape.exportName, file: shape.file, table: shape.table },
                }),
            );
    },
    source: "static",
    title: "Shape bound to an unknown table",
};

export default shapeUnknownTable;
