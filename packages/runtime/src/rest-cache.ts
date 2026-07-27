/**
 * HTTP caching for the opt-in public REST surface (`.expose({ rest: true, cache })`).
 *
 * The whole hazard of caching a procedure-backed endpoint is that the procedure
 * runs under `ctx.auth` and RLS, so its body is frequently caller-specific. A
 * declared `scope` is therefore treated as a REQUEST, not a fact: this module
 * re-derives the effective scope from the live request and downgrades
 * `"public"` → `"private"` whenever the caller presented credentials. That makes
 * "a per-caller response is never stored in a shared cache" structural — the
 * cost of a wrong `scope` is a missed cache hit, never a cross-user leak.
 *
 * Headers are the same trio `httpRoute(...).cacheControl()/.cacheTag()/.vary()`
 * writes (see `@lunora/server`'s `http.ts`), so a `cache.tag` declared here is
 * purgeable through the identical `ctx.cache.purge({ tags: [...] })` surface.
 */

/** Mirror of `@lunora/server`'s `RestCacheConfig`, kept structural so the runtime needs no dependency on the server package. */
interface RestCacheConfigLike {
    readonly maxAge: number;
    readonly scope: "private" | "public";
    readonly staleWhileRevalidate?: number;
    readonly tag?: string;
    readonly vary?: string;
}

/**
 * Request headers whose presence means "this response may be caller-specific".
 * `Authorization` covers bearer/basic auth; `Cookie` covers session cookies —
 * between them, every way a Lunora caller establishes identity over REST.
 */
const CREDENTIAL_HEADERS = ["authorization", "cookie"] as const;

/** `Vary` names added under `scope: "public"` so a shared cache can't serve the anonymous variant to a credentialed caller. */
const CREDENTIAL_VARY = CREDENTIAL_HEADERS;

/** True when the request presented credentials, i.e. the response must be treated as caller-specific. */
const requestCarriesCredentials = (request: Request): boolean => CREDENTIAL_HEADERS.some((header) => request.headers.has(header));

/** Clamp an author-supplied seconds value to a non-negative integer; a non-finite value degrades to `0` (revalidate-always) rather than emitting `NaN`. */
const seconds = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** Merge `Vary` header names case-insensitively, preserving first-seen order and dropping duplicates. */
const mergeVary = (...sources: ReadonlyArray<string | undefined>): string | undefined => {
    const names: string[] = [];

    for (const source of sources) {
        for (const raw of source?.split(",") ?? []) {
            const name = raw.trim().toLowerCase();

            if (name !== "" && !names.includes(name)) {
                names.push(name);
            }
        }
    }

    return names.length === 0 ? undefined : names.join(", ");
};

/**
 * Build the cache headers for one exchange, or `undefined` when the exchange
 * isn't cacheable at all (non-`GET`, or a non-2xx result — an error body must
 * never be stored as if it were the resource).
 *
 * The effective scope is `config.scope` narrowed by {@link requestCarriesCredentials};
 * `"public"` survives only for a genuinely anonymous request.
 */
const restCacheHeaders = (config: RestCacheConfigLike, request: Request, status: number): Record<string, string> | undefined => {
    if (request.method !== "GET" || status < 200 || status > 299) {
        return undefined;
    }

    const scope = config.scope === "public" && !requestCarriesCredentials(request) ? "public" : "private";
    const directives = [scope, `max-age=${String(seconds(config.maxAge))}`];

    if (config.staleWhileRevalidate !== undefined) {
        directives.push(`stale-while-revalidate=${String(seconds(config.staleWhileRevalidate))}`);
    }

    const headers: Record<string, string> = { "cache-control": directives.join(", ") };

    if (config.tag !== undefined && config.tag !== "") {
        headers["cache-tag"] = config.tag;
    }

    // `Vary` is keyed off the DECLARED scope, not the effective one: the point is
    // to fence the stored anonymous variant off from credentialed callers, and
    // that fence has to be present on the anonymous response itself.
    const vary = config.scope === "public" ? mergeVary(config.vary, ...CREDENTIAL_VARY) : mergeVary(config.vary);

    if (vary !== undefined) {
        headers.vary = vary;
    }

    return headers;
};

/**
 * Return `response` with the declared cache headers applied. A shard `Response`
 * has immutable headers, so this rebuilds it (status/statusText/existing headers
 * are carried over, the body is streamed through untouched). When the exchange
 * isn't cacheable the original response is returned as-is — no copy.
 */
const applyRestCache = (response: Response, config: RestCacheConfigLike | undefined, request: Request): Response => {
    if (config === undefined) {
        return response;
    }

    const headers = restCacheHeaders(config, request, response.status);

    if (headers === undefined) {
        return response;
    }

    const cached = new Response(response.body, response);

    for (const [name, value] of Object.entries(headers)) {
        cached.headers.set(name, value);
    }

    return cached;
};

export type { RestCacheConfigLike };
export { applyRestCache, mergeVary, requestCarriesCredentials, restCacheHeaders };
