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
 * Both halves ask the SAME question — {@link effectiveRestScope} — so an endpoint
 * whose header says `private` can never be written to a shared cache. That is the
 * one invariant this module cannot be allowed to derive for itself: a second
 * derivation could gain a credential source the header path has and silently
 * store a per-caller body.
 *
 * The rest of what makes storing safe rather than a cross-user leak:
 *
 * - **`Vary` is enforced in the KEY, not delegated.** Cloudflare's cache honours
 * `Vary` for `Accept-Encoding` only, so a response that varies on
 * `x-lunora-shard-key` (a different shard = a different body) would otherwise
 * be handed to the next caller with a different key. The key folds every
 * varying header's value into the stored URL, which turns the hazard into a
 * cache miss. A response advertising a `Vary` the key does NOT fence on is not
 * stored at all — see {@link fencedBy}.
 *
 * - **Per-caller headers never reach a second caller.** A shard response carries
 * the bookmark and shard key it was answered from ({@link PER_CALLER_HEADERS});
 * replaying those would hand a later caller someone else's read cursor.
 *
 * - **The response is copied before it is stored.** A `Response` body is a
 * single-use stream; the caller's copy and the cache's copy are separate
 * `clone()`s, and the `put` rides `waitUntil` so a slow write never delays the
 * response.
 *
 * - **Neither path can fail a request.** Every cache interaction — including
 * building the key, which reads request headers by policy-supplied name — is
 * wrapped so a throw degrades to a miss. A cache is an optimization; a host
 * that refuses one, or a policy with a malformed `vary`, must not turn a served
 * response into a 500.
 */
import type { HttpCacheLike } from "@lunora/platform";

import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { cacheSeconds, cacheVaryValue } from "../../../shared/rest-surface";
import { effectiveRestScope } from "./rest-cache";

/** Query parameter carrying the varying header values folded into a cache key. Stripped from procedure args by `rest-routes`, and re-set (never appended to) here, so a caller cannot smuggle a value into it either way. */
const VARY_KEY_PARAM = "__lunora_vary";

/** Response header stamped on a cache hit, so the effect is observable in production rather than only inferable from latency. */
const EDGE_CACHE_HEADER = "x-lunora-edge-cache";

/**
 * Response headers that describe the exchange that produced them rather than the
 * resource, and so must not be replayed to a later caller.
 *
 * `x-d1-bookmark` is the sharpest: a client that has written through `.global()`
 * holds a bookmark newer than the stored one, and adopting the stale copy would
 * silently roll back its own read-your-writes.
 */
const PER_CALLER_HEADERS = ["x-d1-bookmark", "x-lunora-shard-key"] as const;

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

/** Split a `Vary` header value into lowercased names. */
const varyNames = (value: string): string[] =>
    value
        .split(",")
        .map((name) => name.trim().toLowerCase())
        .filter((name) => name !== "");

/**
 * Whether every header the RESPONSE says it varies on is one the key actually
 * fences on.
 *
 * `applyRestCache` deliberately MERGES the procedure's own `Vary` into the
 * emitted header (a shard may negotiate on `Accept-Language`, `Origin`, …), while
 * the key folds only the policy's names. Storing a response that advertises more
 * than the key fences would serve one variant in place of another, so the extra
 * name costs a miss instead. `Vary: *` never matches anything by definition.
 */
const fencedBy = (response: Response, fenced: ReadonlyArray<string>): boolean => {
    const advertised = response.headers.get("vary");

    if (advertised === null) {
        return true;
    }

    return varyNames(advertised).every((name) => name !== "*" && fenced.includes(name));
};

/**
 * A route's edge cache, or `undefined` when this route can never use one.
 *
 * Built once per route: everything decidable from the policy alone — is it
 * `public`, is there a freshness window at all, which headers fence the key — is
 * decided at construction rather than re-derived on every request.
 */
interface RestEdgeCache {
    /** A stored response for `request`, or `undefined` on a miss. */
    lookup: (request: Request, context?: ExecutionContextLike) => Promise<Response | undefined>;
    /** Store `response` when the exchange is shared-cacheable; returns the response the caller should return. */
    store: (response: Response, request: Request, context?: ExecutionContextLike) => Response;
}

/**
 * Build the edge cache for one route, or `undefined` when the route declares no
 * policy, opts out (`edgeCache: null`), or declares one no shared cache may ever
 * store: a `private` scope is caller-specific by definition, and a `max-age` of
 * zero leaves no window in which a stored copy would be fresh.
 *
 * `edgeCache` is `undefined` for "whatever the host has", which is resolved per
 * request rather than here — reading `caches.default` at construction time is a
 * disallowed operation in workerd. The POLICY half has no such constraint, which
 * is why only the handle is late-bound.
 */
const restEdgeCacheFor = (policy: RestCachePolicy | undefined, edgeCache: HttpCacheLike | null | undefined): RestEdgeCache | undefined => {
    if (policy === undefined || edgeCache === null || policy.scope !== "public" || cacheSeconds(policy.maxAge) <= 0) {
        return undefined;
    }

    const resolve = (): HttpCacheLike | undefined => edgeCache ?? defaultHttpCache();
    // The same list the emitted `Vary` is built from, so what fences the key and
    // what the response advertises are two views of one value.
    const fenced = varyNames(cacheVaryValue(policy) ?? "");

    /**
     * The cache key for one exchange: the request URL plus the values of every
     * header the policy varies on.
     *
     * Header values are folded under a single reserved query parameter as
     * `name=value` pairs joined by NUL — a byte that cannot appear in a header
     * field-value, so no combination of values can be made to collide with a
     * different one. Absent headers contribute an empty value rather than being
     * skipped, otherwise `{a: "", b: "x"}` and `{a: "x", b: ""}` would key alike.
     * Any caller-supplied copy of the parameter is deleted first: `set` replaces
     * only the first occurrence, so a second one would otherwise ride into the
     * key.
     */
    const keyFor = (request: Request): Request => {
        const url = new URL(request.url);

        url.searchParams.delete(VARY_KEY_PARAM);

        if (fenced.length > 0) {
            url.searchParams.set(VARY_KEY_PARAM, fenced.map((name) => `${name}=${request.headers.get(name) ?? ""}`).join("\0"));
        }

        // A cache key is a lookup token, never a request that gets sent: method and
        // URL are all `match`/`put` read, and rebuilding it from the URL alone keeps
        // the original request's headers and body out of the key.
        return new Request(url.toString(), { method: "GET" });
    };

    /** Whether THIS request may be served from, or written to, the shared cache. */
    const shareable = (request: Request, context?: ExecutionContextLike): boolean =>
        request.method === "GET" && effectiveRestScope(policy, request, context) === "public";

    return {
        lookup: async (request, context) => {
            const cache = resolve();

            if (cache === undefined || !shareable(request, context)) {
                return undefined;
            }

            let hit: Response | undefined;

            try {
                hit = await cache.match(keyFor(request));
            } catch {
                return undefined;
            }

            if (hit === undefined) {
                return undefined;
            }

            // The stored response's headers are immutable, and mutating the cached
            // entry in place would be wrong anyway — stamp a copy.
            const served = new Response(hit.body, hit);

            served.headers.set(EDGE_CACHE_HEADER, "hit");

            return served;
        },

        store: (response, request, context) => {
            const cache = resolve();

            if (cache === undefined || !shareable(request, context)) {
                return response;
            }

            // `put` rejects a 206 and a `Set-Cookie`-bearing response, and neither is
            // something to store anyway: a partial body is not the resource, and a
            // response minting a cookie is caller-specific whatever its declared scope.
            // An x402 settlement receipt is the same in kind — a paid exchange is
            // already unshareable via the `x-payment` credential header, and this is
            // the second lock on a money path.
            if (response.status !== 200 || response.headers.has("set-cookie") || response.headers.has("x-payment-response")) {
                return response;
            }

            if (!fencedBy(response, fenced)) {
                return response;
            }

            try {
                // Rebuilt rather than `clone()`d alone: the copy needs mutable headers
                // so the per-caller ones can be dropped before it is shared.
                const stored = new Response(response.clone().body, response);

                for (const name of PER_CALLER_HEADERS) {
                    stored.headers.delete(name);
                }

                const write = Promise.resolve(cache.put(keyFor(request), stored)).catch(() => {
                    // A cache write is an optimization, and a host that refuses one must
                    // not turn a served response into an error.
                });

                if (context?.waitUntil) {
                    context.waitUntil(write);
                }
            } catch {
                // Same reasoning, for the synchronous half: building the key reads
                // request headers by policy-supplied name (a malformed `vary` throws),
                // and a host's `put` may throw rather than reject.
            }

            return response;
        },
    };
};

export type { RestEdgeCache };
export { defaultHttpCache, EDGE_CACHE_HEADER, restEdgeCacheFor, VARY_KEY_PARAM };
