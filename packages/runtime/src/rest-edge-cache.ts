/**
 * Edge storage for the opt-in public REST surface (`.expose({ rest: true, cache })`).
 *
 * `rest-cache` decides what an exchange's `Cache-Control` / `Vary` should SAY.
 * This module is the other half: actually putting the response somewhere a later
 * request can be answered from. The two are separate because the header half is
 * portable — any host that returns an HTTP response can emit `Cache-Control`,
 * and browsers and downstream CDNs honour it — while the store is a host
 * primitive (`HttpCacheLike`, `caches.default` on Cloudflare) that a target may
 * simply not have.
 *
 * Why this exists at all: a response a Worker GENERATES is not stored by the
 * colo cache on its own. Without a `put()` the declared policy bought browser
 * revalidation and nothing else — every request still paid a shard dispatch. A
 * hit here answers from the colo with no dispatch at all.
 *
 * Three properties make storing safe rather than a cross-user leak waiting to
 * happen:
 *
 * - **Only a genuinely anonymous, `public` exchange is stored.** The effective
 * scope comes from the same {@link requestCarriesCredentials} check the header
 * path uses, so an endpoint declared `public` but called with a credential is
 * never written. A declared-`private` policy is never stored at all: it is
 * caller-specific by definition and this cache is shared by everyone hitting
 * the colo.
 *
 * - **`Vary` is enforced in the KEY, not delegated.** Cloudflare's cache honours
 * `Vary` for `Accept-Encoding` only, so a response that varies on
 * `x-lunora-shard-key` (a different shard = a different body) would otherwise
 * be handed to the next caller with a different key. {@link restCacheKey}
 * folds every varying header's value into the stored URL, which turns the
 * hazard into a cache miss.
 *
 * - **The response is copied before it is stored.** A `Response` body is a
 * single-use stream; the caller's copy and the cache's copy are separate
 * `clone()`s, and the `put` rides `waitUntil` so a slow write never delays the
 * response.
 */
import type { HttpCacheLike } from "@lunora/platform";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { cacheSeconds, cacheVaryValue } from "../../../shared/rest-surface";
import { requestCarriesCredentials } from "./rest-cache";

/** Query parameter carrying the varying header values folded into a cache key. Reserved (`__lunora`-prefixed) so it cannot collide with a procedure argument. */
const VARY_KEY_PARAM = "__lunora_vary";

/** Response header stamped on a cache hit, so the effect is observable in production rather than only inferable from latency. */
const EDGE_CACHE_HEADER = "x-lunora-edge-cache";

/**
 * The colo cache, or `undefined` on a host that has none.
 *
 * Resolved per call rather than once at module scope: reading `caches.default`
 * during global-scope evaluation is a disallowed operation in workerd, and the
 * routes are built at construction time. The lookup is a property access, so
 * repeating it costs nothing worth caching.
 */
const defaultHttpCache = (): HttpCacheLike | undefined => {
    try {
        return (globalThis as { caches?: { default?: HttpCacheLike } }).caches?.default;
    } catch {
        // A runtime that defines `caches` but throws on the `default` accessor
        // (or on the global itself) has no cache we can use — same answer as a
        // runtime with no `caches` at all.
        return undefined;
    }
};

/**
 * Whether this exchange may be written to — and served from — a SHARED cache.
 *
 * Narrower than "has cache headers" on purpose. A `private` response gets its
 * `Cache-Control` and stops there: the browser may keep it, the colo must not.
 * A `max-age` of zero means the same thing by a different route — there is no
 * window in which a stored copy would be fresh, so storing it is pure cost.
 */
const isEdgeCacheable = (policy: RestCachePolicy, request: Request, context?: ExecutionContextLike): boolean =>
    request.method === "GET" && policy.scope === "public" && cacheSeconds(policy.maxAge) > 0 && !requestCarriesCredentials(request, policy, context);

/**
 * The cache key for one exchange: the request URL plus the values of every
 * header the policy varies on.
 *
 * Header values are appended under a single reserved query parameter as
 * `name=value` pairs joined by NUL — a byte that cannot appear in a header
 * field-value, so no combination of values can be made to collide with a
 * different one. Absent headers contribute an empty value rather than being
 * skipped, otherwise `{a: "", b: "x"}` and `{a: "x", b: ""}` would key alike.
 * Names come from {@link cacheVaryValue} — deterministically ordered, and the
 * same list the emitted `Vary` header is built from, so what fences the key and
 * what the response advertises cannot drift.
 */
const restCacheKey = (policy: RestCachePolicy, request: Request): Request => {
    const vary = cacheVaryValue(policy);
    const url = new URL(request.url);

    if (vary !== undefined) {
        const names = vary.split(",").map((name) => name.trim());

        url.searchParams.set(VARY_KEY_PARAM, names.map((name) => `${name}=${request.headers.get(name) ?? ""}`).join("\0"));
    }

    // A cache key is a lookup token, never a request that gets sent: method and
    // URL are all `match`/`put` read, and rebuilding it from the URL alone keeps
    // the original request's headers and body out of the key.
    return new Request(url.toString(), { method: "GET" });
};

/**
 * Look up a stored response for `request`, or `undefined` on a miss (or when the
 * exchange isn't shared-cacheable, or the host has no cache).
 *
 * A hit is returned with {@link EDGE_CACHE_HEADER} stamped on a copy — the
 * stored response's headers are immutable, and mutating the cached entry in
 * place would be wrong anyway.
 */
const lookupRestEdgeCache = async (
    cache: HttpCacheLike | undefined,
    policy: RestCachePolicy | undefined,
    request: Request,
    context?: ExecutionContextLike,
): Promise<Response | undefined> => {
    if (policy === undefined || cache === undefined || !isEdgeCacheable(policy, request, context)) {
        return undefined;
    }

    let hit: Response | undefined;

    try {
        hit = await cache.match(restCacheKey(policy, request));
    } catch {
        // A cache read is an optimization; a host that rejects the lookup gets
        // the same treatment as a miss rather than failing the request.
        return undefined;
    }

    if (hit === undefined) {
        return undefined;
    }

    const served = new Response(hit.body, hit);

    served.headers.set(EDGE_CACHE_HEADER, "hit");

    return served;
};

/**
 * Store `response` for later requests, when the exchange is shared-cacheable.
 *
 * Returns the response the caller should return: `response` itself, with a
 * `clone()` handed to the cache so the two bodies are separate streams. The
 * `put` is fire-and-forget through `waitUntil` (or unawaited when the host gives
 * no `waitUntil`), so a slow or failing write never delays or breaks the
 * response.
 *
 * `response` must already carry its `Cache-Control` from `applyRestCache` —
 * what is stored is exactly what the first caller received.
 */
const storeRestEdgeCache = (
    cache: HttpCacheLike | undefined,
    response: Response,
    policy: RestCachePolicy | undefined,
    request: Request,
    context?: ExecutionContextLike,
): Response => {
    if (policy === undefined || cache === undefined || !isEdgeCacheable(policy, request, context)) {
        return response;
    }

    // `put` rejects a 206 and a `Set-Cookie`-bearing response, and neither is
    // something to store anyway: a partial body is not the resource, and a
    // response minting a cookie is caller-specific whatever its declared scope.
    if (response.status !== 200 || response.headers.has("set-cookie")) {
        return response;
    }

    const stored = response.clone();
    const write = Promise.resolve(cache.put(restCacheKey(policy, request), stored)).catch(() => {
        // Same reasoning as the read path: a cache write is an optimization, and
        // a host that refuses one must not turn a served response into an error.
    });

    if (context?.waitUntil) {
        context.waitUntil(write);
    }

    return response;
};

export { defaultHttpCache, EDGE_CACHE_HEADER, isEdgeCacheable, lookupRestEdgeCache, restCacheKey, storeRestEdgeCache, VARY_KEY_PARAM };
