/**
 * The data-movement admin routes, extracted from `create-worker.ts` (mirroring
 * `./auth-admin-routes`). These admin-gated endpoints move bulk data in and out
 * of a deployment: NDJSON export (`/_lunora/admin/export`), the stateless CDC
 * sync feed (`/_lunora/admin/sync`), the turn-key warehouse-connector sync
 * (`/_lunora/admin/connector/sync`), CDC apply / restore (`/_lunora/admin/apply`),
 * and NDJSON import (`/_lunora/admin/import`).
 *
 * Each handler reaches the admin gate, the coordinator, the shard namespace, and
 * the export/import primitives through the injected {@link DataMovementAdminRouteDeps}.
 * The export/import row producers (`streamExportRows` / `streamingImport`) are
 * injected rather than imported because they close over the worker options and
 * are shared with the scheduled R2 backup — so this module imports no runtime
 * values from `create-worker`, only the shared `./body-readers` + `./connector-cdc`
 * and the coordinator / connector-format types.
 */
import { readBodyTextWithLimit, readJsonBodyWithLimit } from "./body-readers";
import { decodeConnectorCursor, encodeConnectorCursor, foldCdcPage } from "./connector-cdc";
import type { ConnectorChange, ConnectorSyncPage } from "./connector-format";
import { LunoraError } from "./errors";
import type { ExportRow } from "./export-stream";
import type { ExportCursorStore, ExportSink } from "./export-tap";
import { runExportTap } from "./export-tap";
import { methodGuard } from "./method-guard";
import type { QueryCoordinator } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

const EXPORT_PATH = "/_lunora/admin/export";
const IMPORT_PATH = "/_lunora/admin/import";
const SYNC_PATH = "/_lunora/admin/sync";
const CONNECTOR_SYNC_PATH = "/_lunora/admin/connector/sync";
const APPLY_PATH = "/_lunora/admin/apply";
/** Server-owned continuous CDC export tap drain (plan 170). Distinct from the STATELESS `/sync` + `/connector/sync` pulls. */
const EXPORT_TAP_RUN_PATH = "/_lunora/admin/export-tap/run";

/** Per-row import failure surfaced back to the caller. */
type ImportRowError = { code: string; line: number; message: string; table: string };

/** NDJSON line encoder for the streaming export response. */
const NDJSON_ENCODER = new TextEncoder();

interface ExportBody {
    tables: ReadonlyArray<string> | undefined;
}

const parseExportBody = async (request: Request): Promise<ExportBody> => {
    let body: unknown;

    try {
        const text = await readBodyTextWithLimit(request);

        body = text === "" ? {} : JSON.parse(text);
    } catch (error) {
        if (error instanceof LunoraError) {
            throw error;
        }

        throw new LunoraError("Export body must be valid JSON", { code: "BAD_REQUEST", status: 400 });
    }

    const candidate = (body ?? {}) as { tables?: unknown };

    if (candidate.tables === undefined) {
        return { tables: undefined };
    }

    if (!Array.isArray(candidate.tables)) {
        throw new LunoraError("Export `tables` must be a string array", { code: "BAD_REQUEST", status: 400 });
    }

    const tables: string[] = [];

    for (const entry of candidate.tables) {
        if (typeof entry !== "string" || entry.length === 0) {
            throw new LunoraError("Export `tables` entries must be non-empty strings", { code: "BAD_REQUEST", status: 400 });
        }

        tables.push(entry);
    }

    return { tables };
};

/** The worker internals the data-movement routes reach through injection rather than closure. */
interface DataMovementAdminRouteDeps {
    /** Apply `.global()` (D1) CDC changes; absent when no global plane is configured. */
    applyGlobals?: (request: { changes: ReadonlyArray<Record<string, unknown>> }) => Promise<number>;
    /** Enforce the admin bearer for an endpoint that needs no optional dependency. */
    assertAdmin: (request: Request) => void;
    /** Durable per-shard cursor store backing the continuous export tap; absent → the tap route reports not-configured. */
    exportCursorStore?: ExportCursorStore;
    /** Named export sinks (webhook / R2 / custom) the tap can drain to; absent / empty → the tap route reports not-configured. */
    exportSinks?: Record<string, ExportSink>;
    /** Best-effort enumeration of known tables for the auto-discovery path (bound to the worker's table resolver). */
    knownTables: () => string[];
    /** The cross-shard query coordinator; absent on a single-DO deployment. */
    queryCoordinator?: QueryCoordinator;
    /** Admin-gate + require a configured option, else throw the given error. Shared with the sibling admin route modules. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
    /** Resolve the headers forwarded to each shard (incl. the inbound admin bearer + identity). */
    resolveForwardContext: (request: Request, env: unknown) => Promise<{ headers: Record<string, string> }>;
    /** The shard DO namespace fanned across. */
    shardDO: ShardNamespaceLike;

    /**
     * Produce export rows (shard-local then global), invoking `writeRow` per row.
     * Injected because it closes over the worker options and is shared with the
     * scheduled R2 backup.
     */
    streamExportRows: (
        coordinator: QueryCoordinator,
        headers: Record<string, string>,
        tables: ReadonlyArray<string> | undefined,
        writeRow: (row: ExportRow) => void,
    ) => Promise<void>;
    /** Stream-parse + fan-out an NDJSON import body (bound to the worker options). */
    streamingImport: (
        request: Request,
        headers: Record<string, string>,
    ) => Promise<{ conflicts: number; errors: ReadonlyArray<ImportRowError>; inserted: Record<string, number> }>;
    /** Read a page of `.global()` (D1) CDC changes; absent when no global plane is configured. */
    syncGlobals?: (request: { limit?: number; sinceSeq: number }) => Promise<{ changes: ReadonlyArray<Record<string, unknown>>; cursor: number }>;
}

/** Build the data-movement route map merged into the worker's internal route table. */
const buildDataMovementAdminRoutes = (deps: DataMovementAdminRouteDeps): Record<string, (request: Request, env: unknown) => Promise<Response>> => {
    const {
        applyGlobals,
        exportCursorStore,
        exportSinks,
        knownTables,
        queryCoordinator,
        assertAdmin,
        requireAdminOption,
        resolveForwardContext,
        shardDO,
        streamExportRows,
        streamingImport,
        syncGlobals,
    } = deps;

    const handleExport = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        const coordinator = requireAdminOption(request, queryCoordinator, {
            code: "BAD_REQUEST",
            message: "Export endpoint requires a `queryCoordinator` on the worker",
        });

        const body = await parseExportBody(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        // Stream NDJSON: shard-local rows first, then global rows. Caveat: each
        // shard returns a single materialised envelope, and the whole fan-out is
        // collected before the stream drains, so peak worker memory still scales
        // with the total shard-local row count — the streaming only keeps the
        // *response* from being buffered, it does not bound the source data.
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const writeRow = (row: ExportRow): void => {
                    controller.enqueue(NDJSON_ENCODER.encode(`${JSON.stringify(row)}\n`));
                };

                try {
                    await streamExportRows(coordinator, forwardedHeaders, body.tables, writeRow);
                    controller.close();
                } catch (error: unknown) {
                    controller.error(error);
                }
            },
        });

        return new Response(stream, { headers: { "content-type": "application/x-ndjson" }, status: 200 });
    };

    /**
     * Streaming-export feed (Fivetran/Airbyte-style). The caller posts a
     * per-shard cursor map (`{ cursors: { shardKey: seq }, globalCursor }`) and
     * gets back each shard's change page plus its new cursor, and the global
     * (D1) page when `syncGlobals` is configured. Stateless: the consumer owns
     * the cursors and re-posts them to resume, so the worker holds no offsets.
     */
    const handleCdcSync = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        const coordinator = requireAdminOption(request, queryCoordinator, {
            code: "BAD_REQUEST",
            message: "Sync endpoint requires a `queryCoordinator` on the worker",
        });

        const raw = await readJsonBodyWithLimit(request);
        const cursors = typeof raw["cursors"] === "object" && raw["cursors"] !== null ? (raw["cursors"] as Record<string, number>) : {};
        const limit = typeof raw["limit"] === "number" ? raw["limit"] : undefined;
        const globalCursor = typeof raw["globalCursor"] === "number" ? raw["globalCursor"] : 0;
        const requestedTables = Array.isArray(raw["tables"]) ? raw["tables"].filter((table): table is string => typeof table === "string") : undefined;

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        // Shard discovery mirrors export: explicit tables, else every known table.
        const probeTables = requestedTables ?? knownTables();

        const shardResult = await coordinator.orchestrateCdcSync(shardDO, {
            cursors,
            headers: forwardedHeaders,
            limit,
            tables: probeTables,
        });

        const global = syncGlobals ? await syncGlobals({ limit, sinceSeq: globalCursor }) : undefined;

        return Response.json({ global, shards: shardResult.shards }, { status: 200 });
    };

    /**
     * Turn-key incremental-sync source for warehouse connectors (Fivetran custom
     * functions, Airbyte incremental sources). Wraps the same CDC machinery as
     * {@link handleCdcSync} but exposes the standard connector contract:
     *
     * Request: `{ cursor?: string, limit?: number, tables?: string[] }` — `cursor`
     * is the opaque token from the previous page (omit / empty for a fresh sync).
     *
     * Response ({@link ConnectorSyncPage}): `{ changes, nextCursor, hasMore }`.
     * `changes` is a flat list of `{ table, op, doc }` rows across every shard and
     * the global plane, ordered shard-local first then global. `nextCursor` is the
     * opaque token to resume from; `hasMore` is `true` while any shard or the
     * global plane returned a full page (more changes likely remain) — page until
     * it is `false` (caught up). Stateless: the consumer owns the cursor.
     *
     * Incremental semantics are real CDC: the change feed records insert / update /
     * delete with a monotonic per-source `seq`, so deletes ARE captured (a delete
     * surfaces as `{ op: "delete", doc: { _id } }`). A consumer maps the response
     * onto Fivetran/Airbyte via `toFivetranResponse` / `toAirbyteMessages`.
     */
    const handleConnectorSync = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        const coordinator = requireAdminOption(request, queryCoordinator, {
            code: "BAD_REQUEST",
            message: "Connector sync endpoint requires a `queryCoordinator` on the worker",
        });

        const raw = await readJsonBodyWithLimit(request);
        const state = decodeConnectorCursor(raw["cursor"]);
        const limit = typeof raw["limit"] === "number" && raw["limit"] > 0 ? raw["limit"] : undefined;
        const requestedTables = Array.isArray(raw["tables"]) ? raw["tables"].filter((table): table is string => typeof table === "string") : undefined;

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        // Shard discovery mirrors export/sync: explicit tables, else every known table.
        const probeTables = requestedTables ?? knownTables();

        const shardResult = await coordinator.orchestrateCdcSync(shardDO, {
            cursors: state.s,
            headers: forwardedHeaders,
            limit,
            tables: probeTables,
        });

        const changes: ConnectorChange[] = [];
        const nextShardCursors: Record<string, number> = { ...state.s };
        let hasMore = false;

        for (const shard of shardResult.shards) {
            // A full page signals more rows likely remain past this cursor.
            hasMore = foldCdcPage(changes, shard.changes ?? [], limit) || hasMore;
            nextShardCursors[shard.shardKey] = shard.cursor;
        }

        // Global (D1) plane: same CDC contract, paged from the global cursor.
        let nextGlobalCursor = state.g;

        if (syncGlobals) {
            const global = await syncGlobals({ limit, sinceSeq: state.g });

            hasMore = foldCdcPage(changes, global.changes, limit) || hasMore;
            nextGlobalCursor = global.cursor;
        }

        const nextCursor = encodeConnectorCursor({ g: nextGlobalCursor, s: nextShardCursors, v: 1 });
        const page: ConnectorSyncPage = { changes, hasMore, nextCursor };

        return Response.json(page, { status: 200 });
    };

    /**
     * Replay endpoint behind `lunora backup restore --to &lt;time>`. Accepts
     * per-shard pre-bucketed batches (the shape `/sync` emits, so the caller
     * just forwards each shard's changes back to the same shard — no
     * re-bucketing, which also sidesteps deletes carrying no shard-key field)
     * plus optional `globalChanges`. Applies them via `applyCdcChanges` and
     * returns the counts.
     */
    const handleApplyCdc = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        const coordinator = requireAdminOption(request, queryCoordinator, {
            code: "BAD_REQUEST",
            message: "Apply endpoint requires a `queryCoordinator` on the worker",
        });

        const raw = await readJsonBodyWithLimit(request);
        const rawBatches = Array.isArray(raw["batches"]) ? raw["batches"] : [];
        const batches = rawBatches
            .map((batch) => batch as { changes?: unknown; shardKey?: unknown } | null)
            .filter(
                (batch): batch is { changes: ReadonlyArray<Record<string, unknown>>; shardKey: string } =>
                    // Guard object-ness before property access — a `null`/non-object
                    // entry (e.g. `{"batches":[null]}`) would otherwise throw a
                    // TypeError that surfaces as a confusing 500; here it's skipped.
                    batch !== null && typeof batch === "object" && typeof batch.shardKey === "string" && Array.isArray(batch.changes),
            );
        const globalChanges = Array.isArray(raw["globalChanges"]) ? (raw["globalChanges"] as ReadonlyArray<Record<string, unknown>>) : [];

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const shardResult = await coordinator.orchestrateApplyCdc(shardDO, { batches, headers: forwardedHeaders });

        const globalApplied = globalChanges.length > 0 && applyGlobals ? await applyGlobals({ changes: globalChanges }) : 0;

        return Response.json({ applied: shardResult.applied + globalApplied, failed: shardResult.failed, ok: shardResult.ok }, { status: 200 });
    };

    const handleImport = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        // Admin gate only. Import fans out through `streamingImport`, which never
        // touches the coordinator — this used to demand one anyway, which made
        // `lunora seed` (and every other bulk import) fail with "requires a
        // `queryCoordinator`" on every app the builder produces, since the
        // builder has no way to configure one.
        assertAdmin(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const result = await streamingImport(request, forwardedHeaders);

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * Drive one drain pass of the continuous CDC export tap (plan 170) for a named
     * sink. Server-owned + stateful (the OPPOSITE of `/sync` + `/connector/sync`,
     * where the consumer owns the cursor): the tap reads the durable per-shard
     * cursor, pulls the op-log change feed, delivers each shard's ordered batch to
     * the sink with retry/backoff, and persists the advanced cursor — at-least-once.
     *
     * Request: `{ sink: string, limit?: number }`. Response: the {@link runExportTap}
     * result (`delivered`, `cursors`, `failures`, `hasMore`, `shards`). Intended to
     * be poked by a cron or an external scheduler; safe to call repeatedly.
     */
    const handleExportTapRun = async (request: Request, env: unknown): Promise<Response> => {
        const wrongMethod = methodGuard(request, ["POST"]);

        if (wrongMethod) {
            return wrongMethod;
        }

        const coordinator = requireAdminOption(request, queryCoordinator, {
            code: "BAD_REQUEST",
            message: "Export-tap endpoint requires a `queryCoordinator` on the worker",
        });

        if (exportSinks === undefined || Object.keys(exportSinks).length === 0 || exportCursorStore === undefined) {
            throw new LunoraError("Export-tap endpoint requires `exportSinks` + `exportCursorStore` on the worker", {
                code: "EXPORT_TAP_NOT_CONFIGURED",
                status: 400,
            });
        }

        const raw = await readJsonBodyWithLimit(request);
        const sinkName = typeof raw["sink"] === "string" ? raw["sink"] : undefined;
        const limit = typeof raw["limit"] === "number" && raw["limit"] > 0 ? raw["limit"] : undefined;
        const requestedTables = Array.isArray(raw["tables"]) ? raw["tables"].filter((table): table is string => typeof table === "string") : undefined;

        if (sinkName === undefined) {
            throw new LunoraError("Export-tap `sink` must name a configured sink", { code: "BAD_REQUEST", status: 400 });
        }

        const sink = exportSinks[sinkName];

        if (sink === undefined) {
            throw new LunoraError(`Export-tap sink "${sinkName}" is not configured`, { code: "NOT_FOUND", status: 404 });
        }

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);
        const probeTables = requestedTables ?? knownTables();

        const result = await runExportTap({
            coordinator,
            cursorStore: exportCursorStore,
            headers: forwardedHeaders,
            limit,
            shardDO,
            sink,
            tables: probeTables,
        });

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return {
        [APPLY_PATH]: handleApplyCdc,
        [CONNECTOR_SYNC_PATH]: handleConnectorSync,
        [EXPORT_PATH]: handleExport,
        [EXPORT_TAP_RUN_PATH]: handleExportTapRun,
        [IMPORT_PATH]: handleImport,
        [SYNC_PATH]: handleCdcSync,
    };
};

export type { DataMovementAdminRouteDeps };
export { APPLY_PATH, buildDataMovementAdminRoutes, CONNECTOR_SYNC_PATH, EXPORT_PATH, EXPORT_TAP_RUN_PATH, IMPORT_PATH, SYNC_PATH };
