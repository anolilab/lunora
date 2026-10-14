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
 * The header VALUES are not computed here. `shared/rest-surface` owns
 * `cacheControlValue` / `cacheVaryValue`, and the OpenAPI emitter documents the
 * endpoint from those same two functions — so the published spec cannot drift
 * from what this module actually sends. What lives here is only the part that
 * needs a live `Request`: deciding the effective scope, and deciding whether the
 * exchange is cacheable at all.
 *
 * Note the deliberate asymmetry with `httpRoute(...).cacheControl()` in
 * `@lunora/server`: that writes whatever value the author passed, with no
 * credential downgrade. It is the lower-level escape hatch; this is the guarded
 * surface. Do not describe them as equivalent.
 */
import type { ExecutionContextLike } from "../../../shared/execution-context";
import type { RestCachePolicy } from "../../../shared/rest-surface";
import { cacheControlValue, cacheVaryValue, credentialHeadersFor, mergeVary } from "../../../shared/rest-surface";

/**
 * True when the request presented credentials, i.e. the response must be treated
 * as caller-specific. Checks the built-in identity headers plus anything the
 * policy declares via `credentialHeaders` — an app whose `resolveIdentity` reads
 * a bespoke header must say so, or its callers read as anonymous here.
 *
 * A credential does not have to be on the request at all: under a Cloudflare
 * Access policy attached to the Worker, the caller is authenticated by the edge
 * and their identity arrives on the `ExecutionContext` as `access`, with no
 * header this function could see. Its mere presence means Access authorized this
 * specific caller, so it counts as a credential — otherwise a per-user response
 * would be labelled `public` and a shared cache could hand it to the next
 * visitor.
 */
const requestCarriesCredentials = (request: Request, policy: RestCachePolicy, context?: ExecutionContextLike): boolean =>
    context?.access !== undefined || credentialHeadersFor(policy).some((header) => request.headers.has(header));

/**
 * The scope this exchange actually gets: `policy.scope` narrowed by
 * {@link requestCarriesCredentials}, so `"public"` survives only for a genuinely
 * anonymous request.
 *
 * The ONE derivation of that question. The header path and the edge store both
 * call it, which is what makes "a response labelled `private` is never written to
 * a shared cache" structural rather than a documented ordering between two
 * modules. A second copy could gain a credential source this one has and quietly
 * store a per-caller body.
 */
const effectiveRestScope = (policy: RestCachePolicy, request: Request, context?: ExecutionContextLike): "private" | "public" =>
    policy.scope === "public" && !requestCarriesCredentials(request, policy, context) ? "public" : "private";

/**
 * Build the cache headers for one exchange, or `undefined` when the exchange
 * isn't cacheable at all (non-`GET`, or a non-2xx result — an error body must
 * never be stored as if it were the resource).
 *
 * The effective scope is `policy.scope` narrowed by {@link effectiveRestScope};
 * `"public"` survives only for a genuinely anonymous request.
 */
const restCacheHeaders = (policy: RestCachePolicy, request: Request, status: number, context?: ExecutionContextLike): Record<string, string> | undefined => {
    if (request.method !== "GET" || status < 200 || status > 299) {
        return undefined;
    }

    const headers: Record<string, string> = { "cache-control": cacheControlValue(policy, effectiveRestScope(policy, request, context)) };

    if (policy.tag !== undefined && policy.tag !== "") {
        headers["cache-tag"] = policy.tag;
    }

    const vary = cacheVaryValue(policy);

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
const applyRestCache = (response: Response, policy: RestCachePolicy | undefined, request: Request, context?: ExecutionContextLike): Response => {
    if (policy === undefined) {
        return response;
    }

    const headers = restCacheHeaders(policy, request, response.status, context);

    if (headers === undefined) {
        return response;
    }

    const cached = new Response(response.body, response);

    for (const [name, value] of Object.entries(headers)) {
        // `Vary` is merged rather than replaced: the procedure's own response may
        // already vary on `Accept-Language`, `Origin`, or another negotiated
        // header, and dropping those would let a shared cache serve one variant in
        // place of another. Every other header here is ours to state outright.
        cached.headers.set(name, name === "vary" ? (mergeVary(cached.headers.get("vary") ?? undefined, value) ?? value) : value);
    }

    return cached;
};

export { applyRestCache, effectiveRestScope, requestCarriesCredentials, restCacheHeaders };
