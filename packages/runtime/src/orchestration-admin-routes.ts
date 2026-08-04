/**
 * The cross-shard orchestration admin routes, extracted from `create-worker.ts`
 * (mirroring `./auth-admin-routes`). These are the admin-gated endpoints that
 * fan a primitive out across every live shard of a `.shardBy(...)` table via the
 * query coordinator — migrate, rank, rankPage, shard-traffic — plus single-shard
 * PITR. Each one validates at the HTTP edge (the `parse*` helpers below),
 * forwards the inbound admin bearer so the per-shard admin gate accepts the
 * fanned-out RPC, and hands off to the coordinator (or, for PITR, a single shard).
 *
 * Every handler reaches the admin gate, the coordinator, the shard namespace, and
 * the forward-context / shard-forward helpers through the injected
 * {@link OrchestrationAdminRouteDeps}, so this module imports no runtime values
 * from `create-worker` — only the shared `./body-readers` and the coordinator /
 * resolve-shard types.
 */
import { readJsonBodyWithLimit, readLooseJsonBody } from "./body-readers";
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";
import type { QueryCoordinator, RankPageFanOutRequest } from "./query-coordinator";
import type { ShardNamespaceLike } from "./resolve-shard";

const MIGRATE_PATH = "/_lunora/migrate";
const PITR_PATH = "/_lunora/admin/pitr";
const RANK_PATH = "/_lunora/admin/rank";
const RANKPAGE_PATH = "/_lunora/admin/rankpage";
const SHARD_TRAFFIC_PATH = "/_lunora/admin/shard-traffic";

/**
 * Admin RPCs the migration endpoint is allowed to orchestrate. Spelled out
 * inline (rather than importing `@lunora/do`) to keep the runtime free of a
 * hard dependency on the DO package.
 */
const MIGRATION_ADMIN_OPS = new Set<string>(["__lunora_admin__:migrationStatus", "__lunora_admin__:runMigration"]);

/**
 * Admin RPCs the PITR endpoint is allowed to forward. Like {@link MIGRATION_ADMIN_OPS},
 * spelled out inline to keep the runtime free of a hard dependency on the DO package.
 */
const PITR_ADMIN_OPS = new Set<string>(["__lunora_admin__:getPitrBookmark", "__lunora_admin__:pitrRestore"]);

interface MigrateRequest {
    args: Record<string, unknown>;
    functionPath: string;
    table: string;
}

/**
 * Parse and validate a `POST /_lunora/migrate` body. `functionPath` is
 * restricted to the migration admin ops so the endpoint can't be used to
 * fan arbitrary RPCs across every shard.
 */
const parseMigrateRequest = async (request: Request): Promise<MigrateRequest> => {
    const body = await readLooseJsonBody(request, "Migration");

    const candidate = (body ?? {}) as { args?: unknown; functionPath?: unknown; table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        throw new LunoraError("Migration request is missing `table`", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.functionPath !== "string" || !MIGRATION_ADMIN_OPS.has(candidate.functionPath)) {
        throw new LunoraError("Migration request `functionPath` must be a migration admin op", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        args: (candidate.args ?? {}) as Record<string, unknown>,
        functionPath: candidate.functionPath,
        table: candidate.table,
    };
};

interface RankRequestBody {
    index: string;
    partitionKey: string;
    rowId: string;
    sortValues: ReadonlyArray<unknown>;
    table: string;
}

/**
 * Parse and validate a `POST /_lunora/admin/rank` body. The caller supplies the
 * EXPLICIT key tuple — `table`, `index`, `partitionKey`, `sortValues`, `rowId`
 * — already built off the row doc via `@lunora/do`'s `rankKeyFromDoc(index,
 * doc)` (the worker carries no schema, so it can't derive the tuple itself).
 * `partitionKey` may legitimately be `""` (a rankIndex with no `partitionBy`),
 * so only its type is enforced. Mirrors the shard's own `parseRankBeforeArgs`.
 */
const parseRankRequest = async (request: Request): Promise<RankRequestBody> => {
    const body = await readLooseJsonBody(request, "Rank");

    const candidate = (body ?? {}) as { index?: unknown; partitionKey?: unknown; rowId?: unknown; sortValues?: unknown; table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        throw new LunoraError("Rank request is missing `table`", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.index !== "string" || candidate.index.length === 0) {
        throw new LunoraError("Rank request is missing `index`", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.partitionKey !== "string") {
        throw new LunoraError("Rank request `partitionKey` must be a string", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.rowId !== "string" || candidate.rowId.length === 0) {
        throw new LunoraError("Rank request is missing `rowId`", { code: "BAD_REQUEST", status: 400 });
    }

    if (!Array.isArray(candidate.sortValues)) {
        throw new LunoraError("Rank request `sortValues` must be an array", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        index: candidate.index,
        partitionKey: candidate.partitionKey,
        rowId: candidate.rowId,
        sortValues: candidate.sortValues,
        table: candidate.table,
    };
};

interface RankPageCandidate {
    cursor?: unknown;
    directions?: unknown;
    index?: unknown;
    partitionKey?: unknown;
    table?: unknown;
    take?: unknown;
}

/**
 * Validate the optional `directions` list, returning the narrowed value or `undefined`.
 * @returns the narrowed directions array, or `undefined` when absent.
 */
const parseRankPageDirections = (raw: unknown): ReadonlyArray<"asc" | "desc"> | undefined => {
    if (raw === undefined) {
        return undefined;
    }

    if (!Array.isArray(raw) || raw.some((d) => d !== "asc" && d !== "desc")) {
        throw new LunoraError('Rank page request `directions` must be an array of "asc"|"desc"', { code: "BAD_REQUEST", status: 400 });
    }

    return raw as ReadonlyArray<"asc" | "desc">;
};

/** Validate the required `table`/`index` plus the optional `partitionKey`/`take`/`cursor` scalars. */
const validateRankPageScalars = (candidate: RankPageCandidate): void => {
    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        throw new LunoraError("Rank page request is missing `table`", { code: "BAD_REQUEST", status: 400 });
    }

    if (typeof candidate.index !== "string" || candidate.index.length === 0) {
        throw new LunoraError("Rank page request is missing `index`", { code: "BAD_REQUEST", status: 400 });
    }

    if (candidate.partitionKey !== undefined && typeof candidate.partitionKey !== "string") {
        throw new LunoraError("Rank page request `partitionKey` must be a string", { code: "BAD_REQUEST", status: 400 });
    }

    if (candidate.take !== undefined && (typeof candidate.take !== "number" || !Number.isFinite(candidate.take))) {
        throw new LunoraError("Rank page request `take` must be a number", { code: "BAD_REQUEST", status: 400 });
    }

    if (candidate.cursor !== undefined && candidate.cursor !== null && typeof candidate.cursor !== "string") {
        throw new LunoraError("Rank page request `cursor` must be a string or null", { code: "BAD_REQUEST", status: 400 });
    }
};

/**
 * Parse and validate a `POST /_lunora/admin/rankpage` body. Unlike the
 * single-row rank endpoint, the caller doesn't supply a key tuple — only the
 * `table`/`index` to page, an optional `partitionKey` pin, an optional `take`
 * page size, an optional per-sort-key `directions` list (so the coordinator's
 * k-way merge breaks ties the same way each shard's `ORDER BY` does), and an
 * opaque `cursor` from the prior page's `continueCursor`.
 *
 * Validates once at the HTTP edge and produces the coordinator's
 * {@link RankPageFanOutRequest} directly (minus `headers`, which the route
 * injects at the call site from the forward context) — there's no separate
 * in-process request type for the route→coordinator hand-off to drift against.
 */
const parseRankPageRequest = async (request: Request): Promise<Omit<RankPageFanOutRequest, "headers">> => {
    const body = await readLooseJsonBody(request, "Rank page");

    const candidate = (body ?? {}) as RankPageCandidate;

    validateRankPageScalars(candidate);

    const directions = parseRankPageDirections(candidate.directions);

    return {
        // eslint-disable-next-line unicorn/no-null -- the wire cursor is `null | string`; normalize an absent cursor to null so the coordinator starts at the first page
        cursor: typeof candidate.cursor === "string" ? candidate.cursor : null,
        directions,
        index: candidate.index as string,
        partitionKey: typeof candidate.partitionKey === "string" ? candidate.partitionKey : undefined,
        table: candidate.table as string,
        take: typeof candidate.take === "number" ? candidate.take : undefined,
    };
};

interface ShardTrafficRequestBody {
    table: string;
}

/**
 * Parse and validate a `POST /_lunora/admin/shard-traffic` body. The caller
 * supplies only the `table` whose live shards the traffic fan-out runs across;
 * the worker carries no schema, so the table name is the whole request. The
 * fanned `getMetrics` op is fixed, so nothing else is accepted.
 */
const parseShardTrafficRequest = async (request: Request): Promise<ShardTrafficRequestBody> => {
    const body = await readLooseJsonBody(request, "Shard-traffic");

    const candidate = (body ?? {}) as { table?: unknown };

    if (typeof candidate.table !== "string" || candidate.table.length === 0) {
        throw new LunoraError("Shard-traffic request is missing `table`", { code: "BAD_REQUEST", status: 400 });
    }

    return { table: candidate.table };
};

interface PitrRequest {
    args: Record<string, unknown>;
    functionPath: string;
    /** Target shard; omitted means the default (root) shard. */
    shardKey: string | undefined;
}

/**
 * Parse and validate a `POST /_lunora/admin/pitr` body. `functionPath` is
 * restricted to the PITR admin ops so the endpoint can't be turned into a
 * general per-shard RPC bypass of the user-facing authorization callbacks.
 */
const parsePitrRequest = async (request: Request): Promise<PitrRequest> => {
    const body = await readJsonBodyWithLimit(request);
    const candidate = body as { args?: unknown; functionPath?: unknown; shardKey?: unknown };

    if (typeof candidate.functionPath !== "string" || !PITR_ADMIN_OPS.has(candidate.functionPath)) {
        throw new LunoraError("PITR request `functionPath` must be a PITR admin op", { code: "BAD_REQUEST", status: 400 });
    }

    if (candidate.shardKey !== undefined && typeof candidate.shardKey !== "string") {
        throw new LunoraError("PITR `shardKey` must be a string", { code: "BAD_REQUEST", status: 400 });
    }

    return {
        args: (candidate.args ?? {}) as Record<string, unknown>,
        functionPath: candidate.functionPath,
        shardKey: candidate.shardKey,
    };
};

/** The worker internals the orchestration routes reach through injection rather than closure. */
interface OrchestrationAdminRouteDeps {
    /** The default (root) shard key, addressed when a request omits `shardKey`. */
    defaultShard: string;
    /** Forward a prepared request to a single shard's DO stub. */
    forwardToShard: (namespace: ShardNamespaceLike, shardKey: string, request: Request) => Promise<Response>;
    /** Admin-token gate predicate (header bearer check). */
    isAdmin: (request: Request) => boolean;
    /** The cross-shard query coordinator; absent on a single-DO deployment. */
    queryCoordinator?: QueryCoordinator;
    /** Resolve the headers forwarded to each shard (incl. the inbound admin bearer + identity). */
    resolveForwardContext: (request: Request, env: unknown) => Promise<{ headers: Record<string, string> }>;
    /** The shard DO namespace fanned across / forwarded to. */
    shardDO: ShardNamespaceLike;
}

/** Build the cross-shard orchestration + PITR route map merged into the worker's internal route table. */
const buildOrchestrationAdminRoutes = (deps: OrchestrationAdminRouteDeps): Record<string, (request: Request, env: unknown) => Promise<Response>> => {
    const { defaultShard, forwardToShard, isAdmin, queryCoordinator, resolveForwardContext, shardDO } = deps;

    /** The guard triple every coordinator-backed handler runs: POST-only, admin-gated, coordinator configured. `label` names the endpoint in each error. */
    const requireCoordinator = (request: Request, label: string): QueryCoordinator => {
        if (request.method !== "POST") {
            throw new LunoraError(`${label} endpoint requires POST`, { code: "METHOD_NOT_ALLOWED", status: 405 });
        }

        if (!isAdmin(request)) {
            throw new LunoraError("Admin auth required", { code: "FORBIDDEN", status: 403 });
        }

        if (!queryCoordinator) {
            throw new LunoraError(`${label} endpoint requires a \`queryCoordinator\` on the worker`, { code: "BAD_REQUEST", status: 400 });
        }

        return queryCoordinator;
    };

    const handleMigrate = async (request: Request, env: unknown): Promise<Response> => {
        const coordinator = requireCoordinator(request, "Migration");
        const migrate = await parseMigrateRequest(request);

        // Forward the inbound `Authorization` bearer so each shard's admin gate
        // accepts the fanned-out RPC.
        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const result = await coordinator.orchestrateMigration(shardDO, {
            args: migrate.args,
            functionPath: migrate.functionPath,
            headers: forwardedHeaders,
            table: migrate.table,
        });

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * `POST /_lunora/admin/rank` — roll a cross-shard rank up across every live
     * shard of a table. The shard-local per-table `rank()` refuses an index
     * whose partition spans shards (it would return a per-shard slice); this is
     * the path that produces the correct global `{position, total}` by fanning
     * the `__lunora_admin__:rankBefore` primitive out via the coordinator and
     * summing `Σbefore + 1` / `Σtotal`.
     *
     * Admin-gated like the other orchestrators, since the per-shard `rankBefore`
     * RPC it fans out is itself admin-gated — the inbound `Authorization` bearer
     * is forwarded so each shard's admin gate accepts the fanned-out call. The
     * caller passes the EXPLICIT key tuple (built off the row via `rankKeyFromDoc`).
     */
    const handleRank = async (request: Request, env: unknown): Promise<Response> => {
        const coordinator = requireCoordinator(request, "Rank");
        const rank = await parseRankRequest(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const result = await coordinator.orchestrateRank(shardDO, {
            headers: forwardedHeaders,
            index: rank.index,
            partitionKey: rank.partitionKey,
            rowId: rank.rowId,
            sortValues: rank.sortValues,
            table: rank.table,
        });

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * `POST /_lunora/admin/rankpage` — page a ranked query across every live
     * shard of a `.shardBy(...)` table. The shard-local per-table `rankPage()`
     * refuses an index whose partition spans shards (it would return a per-shard
     * slice, not the global order); this is the path that produces the correct
     * globally-ranked page by fanning `__lunora_admin__:rankPage` out via the
     * coordinator and k-way merging the per-shard slices by the rank-key tuple.
     *
     * Admin-gated like the other orchestrators, since the per-shard `rankPage`
     * RPC it fans out is itself admin-gated — the inbound `Authorization` bearer
     * is forwarded so each shard's admin gate accepts the fanned-out call.
     */
    const handleRankPage = async (request: Request, env: unknown): Promise<Response> => {
        const coordinator = requireCoordinator(request, "Rank page");
        const rankPage = await parseRankPageRequest(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const result = await coordinator.orchestrateRankPage(shardDO, {
            ...rankPage,
            headers: forwardedHeaders,
        });

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * `POST /_lunora/admin/shard-traffic` — collect the per-shard request volume
     * across every live shard of a `.shardBy(...)` table, the feed the studio's
     * `hot_shard` advisor lint needs. A single shard's `getMetrics` snapshot
     * can't reveal cross-shard skew, so this fans the cheap metrics read out via
     * the coordinator and returns the whole shard set's `{ shardKey, requests }`
     * totals.
     *
     * Admin-gated like the other orchestrators, since the per-shard `getMetrics`
     * RPC it fans out is itself admin-gated — the inbound `Authorization` bearer
     * is forwarded so each shard's admin gate accepts the fanned-out call.
     */
    const handleShardTraffic = async (request: Request, env: unknown): Promise<Response> => {
        const coordinator = requireCoordinator(request, "Shard-traffic");
        const trafficRequest = await parseShardTrafficRequest(request);

        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const result = await coordinator.orchestrateShardTraffic(shardDO, {
            headers: forwardedHeaders,
            table: trafficRequest.table,
        });

        return Response.json(result, {
            headers: { "content-type": "application/json" },
            status: 200,
        });
    };

    /**
     * `POST /_lunora/admin/pitr` — drive native Durable-Object point-in-time
     * recovery on a single shard. Admin-gated (its own bearer check), so it is
     * NOT subject to the user-facing `authorizeShard`/`authorizeFunction`
     * callbacks the public RPC path enforces; the forwarded `Authorization`
     * header then satisfies the shard's own admin gate in `handleAdminRpc`.
     * Forwards `getPitrBookmark` (read the current / for-a-time bookmark) or
     * `pitrRestore` (`{ time | bookmark, restart? }`) to the chosen shard.
     */
    const handlePitr = async (request: Request, env: unknown): Promise<Response> => {
        assertMethod(request, "POST", "PITR");

        if (!isAdmin(request)) {
            throw new LunoraError("admin PITR endpoint requires a valid admin bearer", { code: "ADMIN_FORBIDDEN", status: 403 });
        }

        const pitr = await parsePitrRequest(request);

        // Forward the inbound admin bearer so the shard's `handleAdminRpc` gate
        // accepts the `__lunora_admin__:*` op.
        const { headers: forwardedHeaders } = await resolveForwardContext(request, env);

        const forwarded = new Request("https://shard.internal/rpc", {
            body: JSON.stringify({ args: pitr.args, functionPath: pitr.functionPath }),
            headers: forwardedHeaders,
            method: "POST",
        });

        return forwardToShard(shardDO, pitr.shardKey ?? defaultShard, forwarded);
    };

    return {
        [MIGRATE_PATH]: handleMigrate,
        [PITR_PATH]: handlePitr,
        [RANK_PATH]: handleRank,
        [RANKPAGE_PATH]: handleRankPage,
        [SHARD_TRAFFIC_PATH]: handleShardTraffic,
    };
};

export type { OrchestrationAdminRouteDeps };
export { buildOrchestrationAdminRoutes, MIGRATE_PATH, PITR_PATH, RANK_PATH, RANKPAGE_PATH, SHARD_TRAFFIC_PATH };
