/**
 * The NDJSON export pipeline, extracted from `create-worker.ts`. Produces export
 * rows for a deployment — shard-local rows (fanned out via the coordinator's
 * `orchestrateExport`) first, then `.global()` (D1) rows (streamed from the
 * `exportGlobals` helper) — invoking a caller-supplied `writeRow` per row.
 * `streamExportRows` is the public entry, shared by the admin export endpoint
 * (which streams the rows back as NDJSON) and the scheduled R2 backup (which
 * writes them to the backup store). The pipeline is parameterised by
 * `WorkerOptions`, so it imports only that type (erased at build) from
 * `create-worker` — no runtime values cross the edge.
 */
import type { AdminTableResolver, WorkerOptions } from "./create-worker";
import type { QueryCoordinator } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

/** One exported row — a table name plus its document. */
type ExportRow = { doc: Record<string, unknown>; table: string };

/**
 * Best-effort enumeration of known tables for the auto-export / auto-sync path.
 * The runtime doesn't carry the schema, so we ask the resolver for a sentinel
 * set by probing common conventions; in practice the codegen-generated worker
 * wraps `resolveTableSharding` with `Object.keys(schema.tables)` and returns
 * via a side channel. For now this falls through to an empty list — the CLI
 * always passes explicit `--tables` so this path is mainly defensive.
 */
const collectKnownTables = (_resolver: AdminTableResolver | undefined): string[] => [];

/**
 * Split a requested table list into shard-local vs `.global()` buckets.
 * `tables === undefined` (every table) yields two empty lists — the callers
 * treat that case specially.
 */
const partitionExportTables = (options: WorkerOptions, tables: ReadonlyArray<string> | undefined): { globalTables: string[]; shardLocalTables: string[] } => {
    const shardLocalTables: string[] = [];
    const globalTables: string[] = [];

    if (tables && tables.length > 0) {
        for (const table of tables) {
            const info = options.resolveTableSharding?.(table);

            if (info?.mode.kind === "global") {
                globalTables.push(table);
            } else {
                shardLocalTables.push(table);
            }
        }
    }

    return { globalTables, shardLocalTables };
};

/**
 * Fan the shard-local export out via the coordinator and write each
 * successful shard's rows. A failed shard is skipped (its error was already
 * surfaced through the fan-out roll-up).
 */
const exportShardLocalRows = async (
    options: WorkerOptions,
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    tables: ReadonlyArray<string> | undefined,
    shardLocalTables: ReadonlyArray<string>,
    writeRow: (row: ExportRow) => void,
    namespace: ShardNamespaceLike,
): Promise<void> => {
    // Skip only when the caller named tables and none are shard-local. When
    // tables is undefined the per-shard exporter visits every shard-local table.
    if (tables !== undefined && shardLocalTables.length === 0) {
        return;
    }

    const exportTables = tables === undefined ? [] : shardLocalTables;
    // We still need a table list to seed the registry probe. Fall back to
    // `resolveTableSharding`'s keys if the caller passed none — best effort;
    // a project without the resolver will simply not fan out automatically.
    const probeFallback = tables === undefined ? collectKnownTables(options.resolveTableSharding) : [];
    const probeTables = exportTables.length > 0 ? exportTables : probeFallback;

    // `namespace` is the worker's jurisdiction-pinned shard binding (create-worker
    // pins it once). Fanning out through it keeps export reading the SAME DOs the
    // app writes to — using the raw `options.shardDO` would resolve the un-pinned
    // global DOs (a different ID per jurisdiction) and return wrong/empty rows.
    const result = await coordinator.orchestrateExport(namespace, {
        args: { tables: exportTables },
        headers: forwardedHeaders,
        tables: probeTables,
    });

    for (const shard of result.shards) {
        if (shard.error) {
            continue;
        }

        for (const row of shard.rows ?? []) {
            writeRow(row);
        }
    }
};

/**
 * Produce export rows — shard-local first (from `orchestrateExport`'s
 * collected per-shard envelopes), then `.global()` rows (streamed from the
 * `exportGlobals` helper) — invoking `writeRow` for each. `tables ===
 * undefined` means "every table". Shared by the admin export endpoint (which
 * streams the rows back as NDJSON) and the scheduled R2 backup (which writes
 * them to the backup store).
 */
const streamExportRows = async (
    options: WorkerOptions,
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    tables: ReadonlyArray<string> | undefined,
    writeRow: (row: ExportRow) => void,
    namespace: ShardNamespaceLike,
): Promise<void> => {
    const { globalTables, shardLocalTables } = partitionExportTables(options, tables);

    await exportShardLocalRows(options, coordinator, forwardedHeaders, tables, shardLocalTables, writeRow, namespace);

    // Globals: stream rows from the D1 helper when configured.
    const exportGlobalsFunction = options.exportGlobals;
    const wantGlobals = tables === undefined || globalTables.length > 0;

    if (wantGlobals && exportGlobalsFunction) {
        const tablesArgument = tables === undefined ? [] : globalTables;

        for await (const row of exportGlobalsFunction({ tables: tablesArgument })) {
            writeRow(row);
        }
    }
};

export type { ExportRow };
export { collectKnownTables, streamExportRows };
