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
import type { HttpCacheLike } from "@lunora/platform";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestExposure } from "../../../shared/rest-surface";
import { describeRestSurface } from "../../../shared/rest-surface";
import { assertArgsObject } from "./assert-args-object";
import { methodGuard } from "./method-guard";
import { applyRestCache } from "./rest-cache";
import { restEdgeCacheFor, VARY_KEY_PARAM } from "./rest-edge-cache";
import { trustedClientIp } from "./trusted-client-ip";

/** The bits of a registered function the REST router reads: its kind and its `.expose` tag. */
interface RestRegistryEntry {
    expose?: RestExposure;
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
 * unused here (the route re-parses it). The context is the real
 * {@link ExecutionContextLike} rather than a `waitUntil`-only projection, because
 * the cache decision reads `context.access` too — see the `applyRestCache` call
 * below.
 */
type RestRoute = (request: Request, env: unknown, url?: URL, context?: ExecutionContextLike) => Promise<Response>;

interface RestRouteDeps {
    /**
     * The shared HTTP cache a declared `cache` policy is stored in. Defaults to
     * the host's own (`caches.default` on Cloudflare); pass a double in tests, or
     * `null` to keep the surface headers-only on a host whose cache should not be
     * used. A host with no cache at all needs no opt-out — `undefined` is what
     * `rest-edge-cache` already finds there.
     */
    edgeCache?: HttpCacheLike | null;
    /** The generated function registry — the source of which procedures are exposed. */
    functions: RestRegistryLike;
    /** The shared RPC dispatch (bound in `create-worker`). */
    invoke: RestInvoke;
    /** Optional rate-limit gate for the public surface. */
    rateLimit?: RestRateLimit;
    /** JSON body reader with the shared size cap. */
    readJsonBody: (request: Request) => Promise<Record<string, unknown>>;
}

/**
 * The resolved REST surface for a registry — the ordered list of exposed
 * `{ functionPath, method, path, kind }`. Exported so a contract test can assert
 * the runtime surface equals the published OpenAPI (both derive from the same
 * `shared/rest-surface` helper).
 */
const restSurfaceFromRegistry = (functions: RestRegistryLike): ReturnType<typeof describeRestSurface> =>
    describeRestSurface(
        Object.entries(functions).map(([functionPath, entry]) => {
            return { exposure: entry.expose, functionPath, kind: entry.kind };
        }),
    );

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
 * array), else kept as a string. `shardKey` (routing) and `__lunora_vary` (the
 * edge cache key) are reserved and excluded.
 */
const argsFromQuery = (url: URL): Record<string, unknown> => {
    // `Object.create(null)` so the result has no prototype chain — a query key
    // named `__proto__` then assigns a plain own property instead of reparenting
    // this object (which `args[key] = …` into a `{}` would otherwise allow, since
    // `__proto__` is an accessor on `Object.prototype`). Matches `v.record`'s
    // null-proto build for the same reason.
    const args: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

    for (const [key, value] of url.searchParams.entries()) {
        // `shardKey` is reserved for routing; `VARY_KEY_PARAM` is reserved for the
        // edge cache key. Neither is an argument, and letting the latter through
        // would hand a caller the one query key it can vary without varying the
        // cache key.
        if (key === "shardKey" || key === VARY_KEY_PARAM) {
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
    const { edgeCache, functions, invoke, rateLimit, readJsonBody } = deps;
    const routes: Record<string, RestRoute> = {};

    for (const entry of restSurfaceFromRegistry(functions)) {
        // A query is reachable via GET or POST; a mutation/action via POST only.
        const allowed = entry.kind === "query" ? ["GET", "POST"] : ["POST"];
        // Read straight off the registry: the surface descriptor is the shared
        // path/method contract with the OpenAPI emitter and deliberately carries
        // no response policy. `entry.functionPath` came out of this same map, so
        // the lookup cannot miss.
        const cache = (functions[entry.functionPath] as RestRegistryEntry).expose?.cache;
        // Built once per route: `undefined` when this route can never edge-cache,
        // so the whole path drops out of the handler for a procedure that declared
        // no policy (or opted out with `edgeCache: null`).
        const edge = restEdgeCacheFor(cache, edgeCache);

        routes[entry.path] = async (request: Request, env: unknown, _url?: URL, context?: ExecutionContextLike): Promise<Response> => {
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

            // After the limiter, before the dispatch — the order a CDN uses. A
            // cache hit must still be metered (it is a request this caller made,
            // and it still costs a Worker invocation), but it must not cost a
            // shard round trip.
            const hit = await edge?.lookup(request, context);

            if (hit) {
                return hit;
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

            // `/_lunora/rpc` rejects a non-object `args` at the edge (`parseEnvelope`);
            // this surface skipped that guard for a POST body that parses to valid
            // JSON but isn't an object (`null` / `[1, 2]` / a bare scalar) — the same
            // check applied here, so REST can't forward what RPC would reject.
            assertArgsObject(args, "REST");

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
            // `private`, see `rest-cache`). The context is passed because one
            // credential — the Cloudflare Access identity under a Worker-scoped
            // policy — arrives there rather than on the request.
            const answered = applyRestCache(response, cache, request, context);

            // Stored only once the headers are on it, so a later hit replays the
            // exact response the first caller got rather than a bare body.
            return edge ? edge.store(answered, request, context) : answered;
        };
    }

    return routes;
};

/** Structural view of a `@lunora/ratelimit` `RateLimiter` — only the `.limit()` call, so the runtime needs no hard dependency. */
interface RateLimiterLike {
    limit: (name: string, args?: { key?: string }) => Promise<{ ok: boolean; reason?: string; retryAfter: number }>;
}

/**
 * The bucket every caller whose IP could not be resolved shares.
 *
 * Charging the limit with no `key` at all would put them in its UNKEYED bucket —
 * the one a deliberately-global charge of the same limit uses — so a single
 * IP-less caller could drain an app-wide limit for everybody. A named bucket
 * keeps that blast radius to the IP-less callers themselves, and makes the
 * pooling visible in storage. Pass `options.key` to key them properly.
 */
const UNRESOLVED_IP_BUCKET = "no-trusted-ip";

/**
 * Adapt a `@lunora/ratelimit` limiter into a {@link RestRateLimit} gate for the
 * public REST surface (plan 167). Pass the limiter and the rate name to charge;
 * `key` isolates the limit per caller (IP / user / API key — defaults to
 * {@link trustedClientIp}, else {@link UNRESOLVED_IP_BUCKET}).
 *
 * That default resolves an IP only ON Cloudflare, where the edge stamps
 * `cf-connecting-ip` over anything the client sent. On any other host it is a
 * header the caller types, so trusting it would give an attacker a fresh bucket
 * per request and the limit would stop applying to exactly the traffic it exists
 * to stop; those deployments pool into {@link UNRESOLVED_IP_BUCKET} instead, and
 * should pass `key` to identify callers by something they cannot forge.
 *
 * An origin fronted by a proxy that stamps a client address can instead declare
 * that header as `trustedClientIpHeader` and get per-IP buckets back, at the cost
 * of asserting the header is unwritable by callers — the same assertion, and the
 * same consequence for getting it wrong, as `WorkerOptions.trustedClientIpHeader`
 * (which governs `ctx.ip`). Declare it in both places or the two disagree about
 * who a request came from.
 *
 * A rate rejection becomes a `429` with a `Retry-After` header (seconds, ceil of
 * the limiter's ms). A deny-list hit becomes a `403` and no `Retry-After` —
 * matching both `@lunora/ratelimit` entry points, and the only honest answer for
 * a denial that never clears: its `retryAfter` is `Infinity`, which renders as
 * the header value `"Infinity"` and invites a client to retry forever.
 *
 * The runtime imports nothing from `@lunora/ratelimit` — build the limiter in
 * the worker entry and pass it here.
 */
const createRestRateLimit =
    (
        limiter: RateLimiterLike,
        options: { key?: (request: Request, functionPath: string) => string | undefined; name: string; trustedClientIpHeader?: string },
    ): RestRateLimit =>
    async (request, functionPath) => {
        const key =
            (options.key ? options.key(request, functionPath) : trustedClientIp(request.headers, options.trustedClientIpHeader)) ?? UNRESOLVED_IP_BUCKET;
        const status = await limiter.limit(options.name, { key });

        if (status.ok) {
            return undefined;
        }

        if (status.reason === "deny") {
            return Response.json({ error: { code: "FORBIDDEN", message: "Request denied" } }, { headers: { "content-type": "application/json" }, status: 403 });
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
export { argsFromQuery, buildRestRoutes, createRestRateLimit, restSurfaceFromRegistry };
