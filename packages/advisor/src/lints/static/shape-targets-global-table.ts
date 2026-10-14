import emit from "../../finding";
import type { AdvisorShape } from "../../shapes";
import type { Lint } from "../../types";

/**
 * Flags a replication shape whose `table` is a `.global()` table.
 *
 * Poke-live replication is a per-shard-DO property: the shard owns its SQLite
 * and a monotonic `__cdc_log`, so a write produces an ordered op the DO pokes to
 * every subscriber at the next flush. A `.global()` table lives outside the
 * shard DO's SQLite op-log (in a global backend — D1, or Hyperdrive-fronted
 * Postgres/MySQL) — so a shape over a global table cannot be poke-live. It is
 * served through the cross-shard tier: **coordinator/poll-refreshed, latency-
 * tiered**, not live. That is a real and supported tier (it is the recommended
 * answer for cross-shard reads — denormalize, or move the joined table to
 * `.global()` and read through the global backend), but its freshness semantics
 * differ from a sharded shape's, so the boundary is surfaced rather than hidden.
 *
 * `WARN`, not `ERROR`: a global-table shape is a legitimate design once you
 * accept the poll-refresh latency; the lint just makes the tier explicit so a
 * developer does not assume poke-live freshness.
 *
 * **Evidence supply**: runs only when the codegen feeder supplies
 * `context.shapes`; the table's tier comes from the schema's `shardKind`. A
 * shape whose table is unknown (caught by `shape_unknown_table`) or whose tier
 * the feeder didn't supply is skipped.
 */
const shapeTargetsGlobalTable: Lint = {
    categories: ["PERFORMANCE"],
    description:
        "A `defineShape` replicates from a `.global()` table. Global tables live outside the shard DO's SQLite op-log, so the shape is served through the cross-shard tier — coordinator/poll-refreshed and latency-tiered, not poke-live like a sharded shape.",
    facing: "EXTERNAL",
    level: "WARN",
    name: "shape_targets_global_table",
    remediation:
        "Expected if you want the cross-shard tier — just don't assume poke-live freshness; global shapes refresh on a poll. For live updates, replicate from a sharded table instead (denormalize the columns you need into the shard).",
    run: (context) => {
        if (context.shapes === undefined) {
            return [];
        }

        const globalTables = new Set(context.schema.tables.filter((table) => table.shardKind === "global").map((table) => table.name));

        return context.shapes
            .filter((shape): shape is AdvisorShape & { table: string } => shape.table !== undefined && globalTables.has(shape.table))
            .map((shape) =>
                emit(shapeTargetsGlobalTable, {
                    cacheKey: `shape_targets_global_table:${shape.exportName}`,
                    detail: `Shape \`${shape.exportName}\` (${shape.file}) replicates from the \`.global()\` table \`${shape.table}\`. It is served through the cross-shard global tier — poll-refreshed and latency-tiered, not poke-live.`,
                    metadata: { exportName: shape.exportName, file: shape.file, table: shape.table },
                }),
            );
    },
    source: "static",
    title: "Shape replicates from a global (cross-shard) table",
};

export default shapeTargetsGlobalTable;
