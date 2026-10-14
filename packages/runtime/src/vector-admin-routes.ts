/**
 * The `/_lunora/admin/vector/*` route cluster, extracted from `create-worker.ts`
 * (mirrors `./auth-admin-routes`). Backs the studio's vector browser: list the
 * indexes (static registry + live `describe()` stats) and run a similarity query.
 * Both reach the admin gate + the injected `vectorIntrospector` through
 * {@link VectorAdminRouteDeps}, so this module imports no runtime values from
 * `create-worker`.
 */
import type { VectorIntrospector } from "./create-worker";
import { LunoraError } from "./errors";
import { assertMethod } from "./method-guard";

const VECTOR_INDEXES_PATH = "/_lunora/admin/vector/indexes";
const VECTOR_QUERY_PATH = "/_lunora/admin/vector/query";

/** The worker internals the vector routes reach through injection rather than closure. */
interface VectorAdminRouteDeps {
    /** Read + parse the JSON request body under the runtime's size limit. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
    /** Admin-gate + require a configured option, else throw the `*_NOT_CONFIGURED` error. */
    requireAdminOption: <T>(request: Request, value: T | undefined, notConfigured: { code: string; message: string }) => T;
    /** The vector introspector off `WorkerOptions`. */
    vectorIntrospector?: VectorIntrospector;
}

/** Build the `/_lunora/admin/vector/*` route map merged into the worker's internal route table. */
const buildVectorAdminRoutes = (deps: VectorAdminRouteDeps): Record<string, (request: Request) => Promise<Response>> => {
    const { readJsonBody, requireAdminOption } = deps;

    const handleVectorIndexes = async (request: Request): Promise<Response> => {
        assertMethod(request, "GET", "Vector-indexes");

        const introspector = requireAdminOption(request, deps.vectorIntrospector, {
            code: "VECTORS_NOT_CONFIGURED",
            message: "vector endpoints require a `vectorIntrospector` on the worker",
        });

        return Response.json({ indexes: await introspector.listIndexes() }, { headers: { "content-type": "application/json" }, status: 200 });
    };

    const handleVectorQuery = async (request: Request): Promise<Response> => {
        assertMethod(request, "POST", "Vector-query");

        const introspector = requireAdminOption(request, deps.vectorIntrospector, {
            code: "VECTORS_NOT_CONFIGURED",
            message: "vector endpoints require a `vectorIntrospector` on the worker",
        });

        if (introspector.queryIndex === undefined) {
            throw new LunoraError("vector index querying is not enabled on this worker", { code: "VECTOR_QUERY_UNSUPPORTED", status: 400 });
        }

        const body = await readJsonBody(request);
        const candidate = body as { name?: unknown; text?: unknown; topK?: unknown };

        if (typeof candidate.name !== "string" || candidate.name === "") {
            throw new LunoraError("Vector-query request requires a `name` string", { code: "BAD_REQUEST", status: 400 });
        }

        if (typeof candidate.text !== "string" || candidate.text === "") {
            throw new LunoraError("Vector-query request requires a `text` string", { code: "BAD_REQUEST", status: 400 });
        }

        if (candidate.topK !== undefined && (typeof candidate.topK !== "number" || !Number.isInteger(candidate.topK) || candidate.topK < 1)) {
            throw new LunoraError("Vector-query `topK` must be a positive integer", { code: "BAD_REQUEST", status: 400 });
        }

        const result = await introspector.queryIndex({ name: candidate.name, text: candidate.text, topK: candidate.topK });

        return Response.json(result, { headers: { "content-type": "application/json" }, status: 200 });
    };

    return {
        [VECTOR_INDEXES_PATH]: handleVectorIndexes,
        [VECTOR_QUERY_PATH]: handleVectorQuery,
    };
};

export type { VectorAdminRouteDeps };
export { buildVectorAdminRoutes, VECTOR_INDEXES_PATH, VECTOR_QUERY_PATH };
