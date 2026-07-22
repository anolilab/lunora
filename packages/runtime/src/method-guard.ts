/**
 * The one "wrong HTTP method" guard shared by the internal route handlers
 * (health/readiness probes, the public REST surface, and the data-movement admin
 * routes). Centralizing it ensures every 405 carries a correct `Allow` header —
 * the data-movement routes previously threw a `405` with none — while each call
 * site keeps its own allowed-method set unchanged.
 */

/**
 * Enforce that `request.method` is one of `allowed`. Returns a `405` {@link Response}
 * with an `Allow` header listing the permitted methods when it is not, or `undefined`
 * when the method is permitted (the caller proceeds).
 */
const methodGuard = (request: Request, allowed: ReadonlyArray<string>): Response | undefined =>
    allowed.includes(request.method) ? undefined : new Response(undefined, { headers: { allow: allowed.join(", ") }, status: 405 });

// eslint-disable-next-line import/prefer-default-export -- named export by repo convention (no default exports)
export { methodGuard };
