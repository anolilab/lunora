/**
 * Memoization wrappers for a `resolveIdentity` resolver.
 *
 * Bring-your-own-auth is the normal adoption path: an existing app already has a
 * session authority (better-auth, Clerk, Auth.js, its own cookie), and
 * `resolveIdentity` is the bridge that turns that session into `ctx.auth`. What
 * every such bridge looks like in practice is a session *verification* — a signature
 * check, a JWKS fetch, often a database read:
 *
 * ```ts
 * resolveIdentity: async (request, env) => {
 *     const auth = createAuth(env, new URL(request.url).origin);
 *     const session = await auth.api.getSession({ headers: request.headers });
 *
 *     return session ? { userId: session.user.id, email: session.user.email } : null;
 * }
 * ```
 *
 * The runtime calls the resolver once per RPC **and once per fan-out leg**, so a
 * cross-shard query multiplies that work by the number of shards, and the
 * construct-the-auth-instance line runs every time too. Nothing in the API hints at
 * that, so the cost is invisible until it shows up as latency.
 *
 * `memoizeIdentityPerRequest` fixes the duplication with no staleness risk at all and
 * is the one to reach for. `memoizeIdentity` additionally caches across requests,
 * which trades a bounded revocation delay for fewer verifications — an explicit
 * choice, never a default.
 */

import { evictOldestEntry } from "../../../shared/evict-oldest";
import type { IdentityResolver } from "./identity-resolvers";

/**
 * Memoize a resolver **within a single request**.
 *
 * The safe default: keyed on the `Request` object itself, so the result is reused by
 * every code path handling that request (the RPC dispatch, each fan-out leg, an
 * admin gate) and discarded the moment the request is collected. It cannot serve a
 * stale identity, because it never outlives the request that produced it — a revoked
 * session is re-verified on the very next request.
 *
 * ```ts
 * createWorker({ resolveIdentity: memoizeIdentityPerRequest(myResolver), … });
 * ```
 */
const memoizeIdentityPerRequest = (resolver: IdentityResolver): IdentityResolver => {
    // A WeakMap over the Request: no eviction policy needed, and no way for an entry
    // to outlive its request.
    const inFlight = new WeakMap<Request, ReturnType<IdentityResolver>>();

    return (request, env) => {
        const cached = inFlight.get(request);

        if (cached) {
            return cached;
        }

        // Cache the PROMISE, not the result, so two concurrent fan-out legs that both
        // miss share one verification instead of racing two.
        const pending = Promise.resolve(resolver(request, env));

        inFlight.set(request, pending);

        return pending;
    };
};

/** Tuning for {@link memoizeIdentity}. */
interface MemoizeIdentityOptions {
    /**
     * Override how a request is reduced to its cache key — **required for
     * correctness** if your resolver authenticates off anything other than the
     * `Cookie` / `Authorization` headers.
     *
     * The default key ({@link credentialKey}) is the raw `Cookie` + `Authorization`
     * pair. That is a *safe* key only when the resolver reads nothing else: two
     * requests share a cache entry precisely when they present identical
     * credentials, so no principal can ever be served another's identity. The
     * moment the resolver keys off some other attribute — an `X-API-Key` header, a
     * client-certificate fingerprint, `new URL(request.url).origin`, a
     * `CF-Access-Jwt-Assertion` — the default is **unsafe**: two distinct
     * principals that happen to share (or both omit) Cookie/Authorization collide
     * onto one entry and the cache serves the WRONG identity across the security
     * boundary.
     *
     * Supply `cacheKey` so the key covers *exactly* the attributes the resolver
     * authenticates on. Return `undefined` for a request that must never be cached
     * (e.g. one carrying no credential at all) — it falls back to the
     * per-request memoization, same as the default key's anonymous case.
     */
    cacheKey?: (request: Request) => string | undefined;

    /**
     * Cache size before the oldest entry is evicted. Defaults to 500 — an isolate
     * serves a bounded set of concurrent users, and an unbounded map in a
     * long-lived isolate is a leak.
     */
    maxEntries?: number;

    /**
     * How long a verified identity is reused for the same credential, in ms.
     * Defaults to 5000.
     *
     * **This is the revocation delay.** A signed-out or revoked session keeps
     * resolving for up to this long, so keep it in the seconds — long enough to
     * collapse a burst (a page load's parallel queries, one query's fan-out across
     * shards), short enough that a sign-out is effectively immediate. Do not raise it
     * into the minutes to save verifications.
     */
    ttlMs?: number;
}

/** Default cache window — long enough to collapse a burst, short enough that sign-out feels immediate. */
const DEFAULT_TTL_MS = 5000;

/** Default cache size — bounded so a long-lived isolate can't grow one forever. */
const DEFAULT_MAX_ENTRIES = 500;

/**
 * The credential a request authenticates with — the DEFAULT cache key.
 *
 * Deliberately the raw `Cookie` + `Authorization` header pair: it is exactly what the
 * resolver verifies, so two requests share a cache entry only when they present
 * identical credentials. Returns `undefined` for a request with neither, which is
 * never cached (an anonymous request has nothing to memoize, and caching "anonymous"
 * under an empty key would let one unauthenticated request suppress verification for
 * the next authenticated one).
 *
 * **Contract — safe ONLY if the resolver reads nothing but `Cookie` / `Authorization`.**
 * This key is the identity of the *credential*, not of the *request*. If the
 * resolver authenticates off any other attribute (an `X-API-Key` header, a client
 * cert, `new URL(request.url).origin`, an Access JWT header, …), two distinct
 * principals sharing (or both lacking) Cookie/Authorization collide onto one entry
 * and the cache serves the WRONG identity. Such a resolver MUST pass
 * {@link MemoizeIdentityOptions.cacheKey} so the key covers exactly what it reads.
 */
const credentialKey = (request: Request): string | undefined => {
    const cookie = request.headers.get("cookie") ?? "";
    const authorization = request.headers.get("authorization") ?? "";

    if (cookie === "" && authorization === "") {
        return undefined;
    }

    // Escaped NUL (\u0000) as the separator so the two header values can never
    // collide across the boundary; written as an escape, not a literal 0x00 byte,
    // to keep this file text (greppable/diffable). Byte-identical key at runtime.
    return `${authorization}\u0000${cookie}`;
};

/**
 * Memoize a resolver **across requests**, keyed on the presented credential, for
 * `ttlMs`.
 *
 * Use it when session verification is genuinely expensive (a JWKS fetch, a D1 read)
 * and a few seconds of revocation delay is acceptable — see
 * {@link MemoizeIdentityOptions.ttlMs}, which is the whole trade-off. Composes with
 * (and subsumes) {@link memoizeIdentityPerRequest}: within one request the same entry
 * is reused regardless of TTL.
 *
 * An anonymous request (no cookie, no bearer) is never cached.
 *
 * **The cross-request cache is keyed on the credential, not the request.** By
 * default that key is the `Cookie` + `Authorization` pair, which is correct *only*
 * if the resolver reads nothing else. A resolver that authenticates off any other
 * attribute MUST supply {@link MemoizeIdentityOptions.cacheKey}, or the cache will
 * serve one principal's identity to another — see that option's contract.
 */
const memoizeIdentity = (resolver: IdentityResolver, options: MemoizeIdentityOptions = {}): IdentityResolver => {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    // A caller whose resolver reads non-standard attributes supplies its own key
    // covering exactly those; otherwise fall back to the Cookie/Authorization key.
    const keyOf = options.cacheKey ?? credentialKey;
    const perRequest = memoizeIdentityPerRequest(resolver);

    // Insertion-ordered, so evicting the first key evicts the oldest entry.
    const cache = new Map<string, { expiresAt: number; value: ReturnType<IdentityResolver> }>();

    return (request, env) => {
        const key = keyOf(request);

        if (key === undefined) {
            return perRequest(request, env);
        }

        const now = Date.now();
        const hit = cache.get(key);

        if (hit && hit.expiresAt > now) {
            return hit.value;
        }

        const pending = Promise.resolve(perRequest(request, env));

        // A rejected verification must not be cached — the next request has to retry
        // rather than inherit a transient failure for the whole TTL.
        pending.catch(() => {
            if (cache.get(key)?.value === pending) {
                cache.delete(key);
            }

            return undefined;
        });

        // `Map.set` on an EXISTING key keeps its original insertion position, so a
        // refreshed hot credential would stay at the old end of the iteration order and
        // could be evicted below before genuinely staler entries added since. Delete
        // first so the re-insert moves it to the back — the eviction loop reads
        // insertion order as recency.
        cache.delete(key);
        evictOldestEntry(cache, maxEntries);
        cache.set(key, { expiresAt: now + ttlMs, value: pending });

        return pending;
    };
};

export type { MemoizeIdentityOptions };
export { memoizeIdentity, memoizeIdentityPerRequest };
