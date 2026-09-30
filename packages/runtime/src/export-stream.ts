/**
 * The NDJSON export pipeline, extracted from `create-worker.ts`. Produces export
 * rows for a deployment — shard-local rows (fanned out via the coordinator's
 * `orchestrateExport`) first, then `.global()` (D1) rows (streamed from the
 * `exportGlobals` helper). `prepareExportRows` is the entry the admin export
 * endpoint uses (it settles the fan-out before committing a status, then
 * streams the rows back as NDJSON); `streamExportRows` wraps it for the
 * scheduled R2 backup, which writes them to the backup store. The pipeline is parameterised by
 * `WorkerOptions`, so it imports only that type (erased at build) from
 * `create-worker` — no runtime values cross the edge.
 */
import type { WorkerOptions } from "./create-worker";
import { LunoraError } from "./errors";
import type { QueryCoordinator } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

/** One exported row — a table name plus its document. */
type ExportRow = { doc: Record<string, unknown>; table: string };

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
 * Fan the shard-local export out via the coordinator and collect each shard's
 * rows.
 *
 * A shard that failed aborts the whole export. The rows it holds are simply
 * absent from the roll-up, and there is no way to say so in-band: the NDJSON
 * body is a row per line with no envelope, so a shorter file is
 * indistinguishable from a smaller deployment. Skipping the shard therefore
 * handed the caller an incomplete snapshot labelled complete — one the scheduled
 * backup then wrote a manifest for. Throwing is the one signal a consumer cannot
 * mistake for success: the backup writes nothing, and the admin endpoint, which
 * awaits this before committing a status, answers 502.
 */
const exportShardLocalRows = async (
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    tables: ReadonlyArray<string> | undefined,
    shardLocalTables: ReadonlyArray<string>,
    namespace: ShardNamespaceLike,
    defaultShardKey: string,
): Promise<ExportRow[]> => {
    // Skip only when the caller named tables and none are shard-local. When
    // tables is undefined the per-shard exporter visits every shard-local table.
    if (tables !== undefined && shardLocalTables.length === 0) {
        return [];
    }

    // `tables === undefined` (export everything) leaves `shardLocalTables` empty
    // when the worker cannot enumerate its schema: the args still tell each shard
    // "every table", but the registry probe has no seed. `defaultShardKey` is what
    // keeps that case from exporting NOTHING — the default shard is contacted and
    // hands back every table it holds. A deployment with `.shardBy(...)` tables
    // still needs a seeded table list to reach the other DOs, which is why
    // `prepareExportRows` fills one in from `listSchemaTables` when it can.
    //
    // `namespace` is the worker's jurisdiction-pinned shard binding (create-worker
    // pins it once). Fanning out through it keeps export reading the SAME DOs the
    // app writes to — using the raw `options.shardDO` would resolve the un-pinned
    // global DOs (a different ID per jurisdiction) and return wrong/empty rows.
    const result = await coordinator.orchestrateExport(namespace, {
        args: { tables: shardLocalTables },
        defaultShardKey,
        headers: forwardedHeaders,
        tables: shardLocalTables,
    });

    // Checked before any row is handed back, so a failed fan-out never becomes
    // a snapshot truncated mid-table.
    const failed = result.shards.filter((shard) => shard.error);

    if (failed.length > 0) {
        const detail = failed.map((shard) => `${shard.shardKey}: ${shard.error?.message ?? "unknown error"}`).join("; ");

        throw new LunoraError(`export failed on ${String(failed.length)} of ${String(result.shards.length)} shard(s) — ${detail}`, {
            code: "EXPORT_SHARD_FAILED",
            status: 502,
        });
    }

    return result.shards.flatMap((shard) => shard.rows ?? []);
};

/**
 * Settle an export's shard-local fan-out and hand back every row it writes —
 * shard-local first, then `.global()` rows streamed from the `exportGlobals`
 * helper. `tables === undefined` means "every table".
 *
 * The fan-out completes before this resolves, so everything that can refuse
 * the export — a shard the coordinator failed to reach, a `.shardBy()` table
 * the registry cannot list (the worker's default registry refuses those) —
 * throws here, while the admin endpoint can still answer with a status. Only
 * the global half streams.
 */
const prepareExportRows = async (
    options: WorkerOptions,
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    tables: ReadonlyArray<string> | undefined,
    namespace: ShardNamespaceLike,
): Promise<AsyncIterable<ExportRow>> => {
    // "Every table" is a real table list when codegen could supply one. Shard
    // discovery is driven by that list, so without it only the default shard is
    // contacted and a whole-deployment export silently comes back short.
    const seeded = tables ?? options.listSchemaTables?.();

    // Said out loud, once, to the operator whose backup is short — the invariant is
    // otherwise only documented, and a caller cannot tell a partial export from a
    // deployment that genuinely has one shard.
    if (tables === undefined && options.listSchemaTables === undefined) {
        // eslint-disable-next-line no-console -- operational warning on a data-export path; there is no logger in scope here
        console.warn(
            "[lunora] export: no table list available (`listSchemaTables` is unset and no `tables` were named), so only the default shard is reachable. " +
                "A `.shardBy()` deployment's other shards will be missing from this export. Name the tables explicitly, or regenerate the worker so codegen supplies the list.",
        );
    }
    const { globalTables, shardLocalTables } = partitionExportTables(options, seeded);

    const shardRows = await exportShardLocalRows(coordinator, forwardedHeaders, seeded, shardLocalTables, namespace, options.defaultShardKey ?? "__root__");

    const exportGlobalsFunction = options.exportGlobals;
    const wantGlobals = tables === undefined || globalTables.length > 0;

    return (async function* rows(): AsyncGenerator<ExportRow> {
        yield* shardRows;

        if (wantGlobals && exportGlobalsFunction) {
            // `tables === undefined` leaves `globalTables` empty — "every table" on the wire.
            yield* exportGlobalsFunction({ tables: globalTables });
        }
    })();
};

/** Drain {@link prepareExportRows} into `writeRow` — the scheduled backup's entry. */
const streamExportRows = async (
    options: WorkerOptions,
    coordinator: QueryCoordinator,
    forwardedHeaders: Record<string, string>,
    tables: ReadonlyArray<string> | undefined,
    writeRow: (row: ExportRow) => void,
    namespace: ShardNamespaceLike,
): Promise<void> => {
    for await (const row of await prepareExportRows(options, coordinator, forwardedHeaders, tables, namespace)) {
        writeRow(row);
    }
};

export type { ExportRow };
export { prepareExportRows, streamExportRows };
