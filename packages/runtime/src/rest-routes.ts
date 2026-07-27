/**
 * Opt-in public REST surface over declared procedures (plan 167). A procedure is
 * reachable over REST ONLY when it declares `.expose({ rest: true })`; the router
 * is built from the function registry at construction, so a non-exposed procedure
 * has no route at all (default-closed — it 404s, it is never merely "hidden").
 *
 * Crucially, a REST call is routed THROUGH the procedure via the SAME dispatch the
 * typed RPC path uses (the injected {@link RestRouteDeps.invoke}, bound in
 * `create-worker` to `resolveForwardContext` → `authorizeRpcEnvelope` →
 * `dispatchSingleShard`). So auth (`ctx.auth`), row-level security, and the
 * `v.*` argument validators are enforced at the shard exactly as for RPC — REST is
 * a transport adapter, not a second, weaker entry point. There is deliberately NO
 * table-level auto-CRUD (that would bypass RLS).
 *
 * The path/method mapping is derived from the shared `shared/rest-surface`
 * contract that the OpenAPI emitter also uses, so the published spec and the live
 * surface cannot drift.
 */
import type { RestExposure } from "../../../shared/rest-surface";
import { describeRestSurface } from "../../../shared/rest-surface";
import { methodGuard } from "./method-guard";
import type { RestCacheConfigLike } from "./rest-cache";
import { applyRestCache } from "./rest-cache";

/** The bits of a registered function the REST router reads: its kind and its `.expose` tag. */
interface RestRegistryEntry {
    expose?: RestExposure & { cache?: RestCacheConfigLike };
    kind: "action" | "mutation" | "query" | "stream";
}

/** Registry map (structurally the generated `LUNORA_FUNCTIONS`, narrowed to what REST needs). */
type RestRegistryLike = Record<string, RestRegistryEntry>;

/** Dispatch one exposed procedure through the shared RPC path (auth + RLS + validators enforced at the shard). Returns the shard `Response`. */
type RestInvoke = (parameters: {
    args: Record<string, unknown>;
    env: unknown;
    functionPath: string;
    request: Request;
    shardKey?: string;
    /** The request's `waitUntil`, so dispatch telemetry survives isolate teardown. */
    waitUntil?: (promise: Promise<unknown>) => void;
}) => Promise<Response>;

/**
 * Optional per-request rate-limit gate for the public surface. Returns a `429`
 * `Response` when the request is limited (the router returns it verbatim), or
 * `undefined` to let the call through. Built in `create-worker` over
 * `@lunora/ratelimit`.
 */
type RestRateLimit = (request: Request, functionPath: string) => Promise<Response | undefined> | Response | undefined;

/**
 * A built REST route. Takes the same `(request, env, url, context)` shape as the
 * runtime's internal route table so it can be spread straight into it; `url` is
 * unused here (the route re-parses it) and `context` is read only for its
 * `waitUntil`, which keeps dispatch telemetry alive past the response.
 */
type RestRoute = (request: Request, env: unknown, url?: URL, context?: { waitUntil?: (promise: Promise<unknown>) => void }) => Promise<Response>;

interface RestRouteDeps {
    /** The generated function registry — the source of which procedures are exposed. */
    functions: RestRegistryLike;
    /** The shared RPC dispatch (bound in `create-worker`). */
    invoke: RestInvoke;
    /** Optional rate-limit gate for the public surface. */
    rateLimit?: RestRateLimit;
    /** JSON body reader with the shared size cap. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
}

/** Map a registry into the shared surface-descriptor input. */
const registryToSurfaceInput = (functions: RestRegistryLike): { exposure?: RestExposure; functionPath: string; kind: RestRegistryEntry["kind"] }[] =>
    Object.entries(functions).map(([functionPath, entry]) => {
        return { exposure: entry.expose, functionPath, kind: entry.kind };
    });

/**
 * The resolved REST surface for a registry — the ordered list of exposed
 * `{ functionPath, method, path, kind }`. Exported so a contract test can assert
 * the runtime surface equals the published OpenAPI (both derive from the same
 * `shared/rest-surface` helper).
 */
const restSurfaceFromRegistry = (functions: RestRegistryLike): ReturnType<typeof describeRestSurface> => describeRestSurface(registryToSurfaceInput(functions));

/** Read `shardKey` from `?shardKey=` or the `x-lunora-shard-key` header; `undefined` routes to the default shard. */
const readShardKey = (url: URL, request: Request): string | undefined => {
    const fromQuery = url.searchParams.get("shardKey");

    if (fromQuery !== null && fromQuery !== "") {
        return fromQuery;
    }

    const fromHeader = request.headers.get("x-lunora-shard-key");

    return fromHeader === null || fromHeader === "" ? undefined : fromHeader;
};

/**
 * Decode GET args from the query string. Each value is parsed as JSON when it
 * looks like a JSON scalar/array/object (so `?limit=10` → number, `?ids=[1,2]` →
 * array), else kept as a string. `shardKey` is reserved for routing and excluded.
 */
const argsFromQuery = (url: URL): Record<string, unknown> => {
    const args: Record<string, unknown> = {};

    for (const [key, value] of url.searchParams.entries()) {
        if (key === "shardKey") {
            continue;
        }

        try {
            args[key] = JSON.parse(value);
        } catch {
            args[key] = value;
        }
    }

    return args;
};

/**
 * Build the REST route map merged into the worker's internal route table. One
 * exact-path entry per exposed procedure — so the surface is closed by
 * construction. A `query` handler accepts `GET` (args from the query string) and
 * `POST` (args from a JSON body); a `mutation` / `action` accepts `POST` only.
 */
const buildRestRoutes = (deps: RestRouteDeps): Record<string, RestRoute> => {
    const { functions, invoke, rateLimit, readJsonBody } = deps;
    const routes: Record<string, RestRoute> = {};

    for (const entry of restSurfaceFromRegistry(functions)) {
        // A query is reachable via GET or POST; a mutation/action via POST only.
        const allowed = entry.kind === "query" ? ["GET", "POST"] : ["POST"];
        // Read straight off the registry: the surface descriptor is the shared
        // path/method contract with the OpenAPI emitter and deliberately carries
        // no response policy.
        const cache = functions[entry.functionPath]?.expose?.cache;

        routes[entry.path] = async (
            request: Request,
            env: unknown,
            _url?: URL,
            context?: { waitUntil?: (promise: Promise<unknown>) => void },
        ): Promise<Response> => {
            const wrongMethod = methodGuard(request, allowed);

            if (wrongMethod) {
                return wrongMethod;
            }

            const url = new URL(request.url);

            // Rate-limit the public surface BEFORE any dispatch work. A `429` from
            // the limiter is returned verbatim (it carries `Retry-After`).
            if (rateLimit) {
                const limited = await rateLimit(request, entry.functionPath);

                if (limited) {
                    return limited;
                }
            }

            let args: Record<string, unknown>;

            if (request.method === "GET") {
                args = argsFromQuery(url);
            } else {
                // POST body is optional (a no-arg procedure can be called with no
                // body at all → `request.body` is `null`); a present body is parsed
                // as JSON under the shared size cap, and unparseable JSON is a 400.
                args = request.body === null ? {} : await readJsonBody(request);
            }

            const shardKey = readShardKey(url, request);

            const response = await invoke({
                args,
                env,
                functionPath: entry.functionPath,
                request,
                ...(shardKey === undefined ? {} : { shardKey }),
                ...(context?.waitUntil === undefined ? {} : { waitUntil: (promise: Promise<unknown>) => context.waitUntil?.(promise) }),
            });

            // Applied AFTER dispatch so the effective `Cache-Control` can account
            // for the real status (an error is never cached) and for whether the
            // caller presented credentials (a credentialed exchange is forced
            // `private`, see `rest-cache`).
            return applyRestCache(response, cache, request);
        };
    }

    return routes;
};

/** Structural view of a `@lunora/ratelimit` `RateLimiter` — only the `.limit()` call, so the runtime needs no hard dependency. */
interface RateLimiterLike {
    limit: (name: string, args?: { key?: string }) => Promise<{ ok: boolean; retryAfter: number }>;
}

/**
 * Adapt a `@lunora/ratelimit` limiter into a {@link RestRateLimit} gate for the
 * public REST surface (plan 167). Pass the limiter and the rate name to charge;
 * `key` isolates the limit per caller (IP / user / API key — defaults to the
 * `cf-connecting-ip` header, else a shared bucket). A denied request becomes a
 * `429` with a `Retry-After` header (seconds, ceil of the limiter's ms). The
 * runtime imports nothing from `@lunora/ratelimit` — build the limiter in the
 * worker entry and pass it here.
 */
const createRestRateLimit =
    (limiter: RateLimiterLike, options: { key?: (request: Request, functionPath: string) => string | undefined; name: string }): RestRateLimit =>
    async (request, functionPath) => {
        const key = options.key ? options.key(request, functionPath) : (request.headers.get("cf-connecting-ip") ?? undefined);
        const status = await limiter.limit(options.name, key === undefined ? {} : { key });

        if (status.ok) {
            return undefined;
        }

        const retryAfterSeconds = Math.max(1, Math.ceil(status.retryAfter / 1000));

        return Response.json(
            { error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } },
            {
                headers: { "content-type": "application/json", "retry-after": String(retryAfterSeconds) },
                status: 429,
            },
        );
    };

export type { RateLimiterLike, RestInvoke, RestRateLimit, RestRegistryEntry, RestRegistryLike, RestRoute, RestRouteDeps };
export { argsFromQuery, buildRestRoutes, createRestRateLimit, readShardKey, restSurfaceFromRegistry };
