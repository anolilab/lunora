/**
 * The static-introspection admin routes, extracted from `create-worker.ts`
 * (mirroring `./auth-admin-routes`). These are the read-only endpoints the studio
 * polls to discover a deployment's shape: the function registry, the cron map,
 * the OpenAPI / OpenRPC specs, and the `.global()` (D1) tables. Each reaches the
 * admin gate, option registry, and request helpers through injected deps, so the
 * module imports no runtime values from `create-worker` (only its types).
 */
import type { CronJobDispatch, CronJobInfo, FunctionDescriptor, FunctionRegistryLike, GlobalFilterClause, GlobalIntrospector } from "./create-worker";
import { describeArguments } from "./describe-args";
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";

const FUNCTIONS_PATH = "/_lunora/admin/functions";
const CRON_JOBS_PATH = "/_lunora/admin/cron-jobs";
const OPENAPI_PATH = "/_lunora/admin/openapi";
const OPENRPC_PATH = "/_lunora/admin/openrpc";
const GLOBAL_TABLES_PATH = "/_lunora/admin/global/tables";
const GLOBAL_TABLE_PATH = "/_lunora/admin/global/table";
const GLOBAL_FACET_PATH = "/_lunora/admin/global/facet";

/**
 * Decode the global browser's `filters` query param: a JSON array of eq
 * constraints (`{ column, value }`) a facet-value click drills into. Lenient —
 * absent / malformed / non-array input yields `undefined` (no filtering) rather
 * than a 400, and each entry is kept only when its `column` is a string; the
 * value is bound server-side so a bad shape can never inject SQL.
 * @returns the parsed filter clauses, or `undefined` when absent/malformed.
 */
const parseGlobalFilters = (raw: string | undefined): GlobalFilterClause[] | undefined => {
    if (raw === undefined || raw === "") {
        return undefined;
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return undefined;
    }

    if (!Array.isArray(parsed)) {
        return undefined;
    }

    const clauses = parsed.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null || typeof (entry as { column?: unknown }).column !== "string") {
            return [];
        }

        const { column, value } = entry as { column: string; value?: unknown };

        return [{ column, value }];
    });

    return clauses.length === 0 ? undefined : clauses;
};

/**
 * Empty-but-valid OpenAPI 3.1 document served by `GET /_lunora/admin/openapi`
 * when no `openApiSpec` is injected. A spec-less worker still answers 200 with a
 * well-formed document (no paths), so the studio's API-reference view renders a
 * clean "not configured" state. Frozen so the shared instance can't be mutated.
 */
const EMPTY_OPENAPI_DOCUMENT = Object.freeze({
    info: {
        description:
            'No OpenAPI spec is configured on this worker. Run `lunora codegen`, then wire the generated module to `createWorker`: `import { openApiSpec } from "./lunora/_generated/openapi"`.',
        title: "Lunora API",
        version: "0.0.0",
    },
    openapi: "3.1.0",
    paths: {},
});

/** Empty-but-valid OpenRPC 1.x document served when no `openRpcSpec` is injected. Mirrors {@link EMPTY_OPENAPI_DOCUMENT}. */
const EMPTY_OPENRPC_DOCUMENT = Object.freeze({
    info: {
        description:
            'No OpenRPC spec is configured on this worker. Run `lunora codegen --api-spec openrpc` (or `both`), then wire the generated module to `createWorker`: `import { openRpcSpec } from "./lunora/_generated/openrpc"`.',
        title: "Lunora RPC",
        version: "0.0.0",
    },
    methods: [],
    openrpc: "1.3.2",
});

/** The worker internals the static-introspection routes reach through injection rather than closure. */
interface IntrospectionAdminRouteDeps {
    /** Admin-token gate (throws 403) — used by the spec routes, which serve a default even when unconfigured. */
    assertAdmin: (request: Request) => void;
    options: {
        cronJobs?: Record<string, ReadonlyArray<CronJobDispatch>>;
        functions?: FunctionRegistryLike;
        globalIntrospector?: GlobalIntrospector;
        openApiSpec?: unknown;
        openRpcSpec?: unknown;
    };
    parsePaging: (request: Request) => { limit?: number; offset?: number };
    queryParameter: (url: URL, name: string) => string | undefined;
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
}

/** Build the static-introspection route map (`functions` / `cron-jobs` / `openapi` / `openrpc` / `global/*`). */
const buildIntrospectionAdminRoutes = (deps: IntrospectionAdminRouteDeps): Record<string, (request: Request) => Promise<Response> | Response> => {
    const { assertAdmin, options, parsePaging, queryParameter, requireAdminOption } = deps;

    const handleFunctionsList = (request: Request): Response => {
        assertMethod(request, "GET", "Functions");

        const registry = requireAdminOption(request, options.functions, {
            code: "FUNCTIONS_NOT_CONFIGURED",
            message: "functions endpoint requires a `functions` registry on the worker",
        });

        // Internal functions are never exposed — unreachable from the client RPC
        // path. `stream` functions are likewise omitted: the runner invokes
        // query/mutation/action only. The early-return narrows `entry.kind`.
        const functions: FunctionDescriptor[] = Object.entries(registry)
            .flatMap(([path, entry]) => {
                if (entry.visibility === "internal" || entry.kind === "stream") {
                    return [];
                }

                return [{ args: describeArguments(entry.args), kind: entry.kind, path }];
            })
            .toSorted((a, b) => a.path.localeCompare(b.path));

        return Response.json({ functions }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleCronJobs = (request: Request): Response => {
        assertMethod(request, "GET", "Cron-jobs");

        const registry = requireAdminOption(request, options.cronJobs, {
            code: "CRON_JOBS_NOT_CONFIGURED",
            message: "cron-jobs endpoint requires a `cronJobs` map on the worker",
        });

        // Flatten the `cron expression → dispatches[]` map into a flat, sorted list
        // — one row per scheduled invocation. Cloudflare exposes no runtime cron
        // introspection, so this injected map is the only source of truth.
        const jobs: CronJobInfo[] = Object.entries(registry)
            .flatMap(([cron, dispatches]) =>
                dispatches.map((dispatch) => {
                    return {
                        args: dispatch.args,
                        cron,
                        functionPath: dispatch.functionPath,
                        name: dispatch.name,
                        shardKey: dispatch.shardKey,
                        workflow: dispatch.workflow,
                    };
                }),
            )
            .toSorted((a, b) => a.name.localeCompare(b.name));

        return Response.json({ jobs }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleOpenApi = (request: Request): Response => {
        assertMethod(request, "GET", "OpenAPI");

        assertAdmin(request);

        // Serve the injected spec verbatim; with none configured, answer 200 with an
        // empty-but-valid document so the studio renders a clean "not configured" state.
        return Response.json(options.openApiSpec ?? EMPTY_OPENAPI_DOCUMENT, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleOpenRpc = (request: Request): Response => {
        assertMethod(request, "GET", "OpenRPC");

        assertAdmin(request);

        return Response.json(options.openRpcSpec ?? EMPTY_OPENRPC_DOCUMENT, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleGlobalTables = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Global-tables");

        const introspector = requireAdminOption(request, options.globalIntrospector, {
            code: "GLOBALS_NOT_CONFIGURED",
            message: "global endpoints require a `globalIntrospector` on the worker",
        });

        return Response.json(await introspector.listTables(), { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleGlobalTablePage = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Global-table");

        const introspector = requireAdminOption(request, options.globalIntrospector, {
            code: "GLOBALS_NOT_CONFIGURED",
            message: "global endpoints require a `globalIntrospector` on the worker",
        });

        const url = new URL(request.url);
        const table = queryParameter(url, "table");

        if (table === undefined) {
            throw new LunoraError("Global-table endpoint requires a `table` query param", { code: "BAD_REQUEST", status: 400 });
        }

        const page = await introspector.readTablePage({ ...parsePaging(request), filters: parseGlobalFilters(queryParameter(url, "filters")), table });

        return Response.json(page, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleGlobalFacet = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Global-facet");

        const introspector = requireAdminOption(request, options.globalIntrospector, {
            code: "GLOBALS_NOT_CONFIGURED",
            message: "global endpoints require a `globalIntrospector` on the worker",
        });

        const url = new URL(request.url);
        const table = queryParameter(url, "table");
        const column = queryParameter(url, "column");

        if (table === undefined || column === undefined) {
            throw new LunoraError("Global-facet endpoint requires `table` and `column` query params", { code: "BAD_REQUEST", status: 400 });
        }

        const limitParameter = queryParameter(url, "limit");
        const limit = limitParameter === undefined ? undefined : Number(limitParameter);

        const result = await introspector.facetColumn({
            column,
            filters: parseGlobalFilters(queryParameter(url, "filters")),
            limit: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
            table,
        });

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return {
        [CRON_JOBS_PATH]: handleCronJobs,
        [FUNCTIONS_PATH]: handleFunctionsList,
        [GLOBAL_FACET_PATH]: handleGlobalFacet,
        [GLOBAL_TABLE_PATH]: handleGlobalTablePage,
        [GLOBAL_TABLES_PATH]: handleGlobalTables,
        [OPENAPI_PATH]: handleOpenApi,
        [OPENRPC_PATH]: handleOpenRpc,
    };
};

export type { IntrospectionAdminRouteDeps };
export { buildIntrospectionAdminRoutes };
