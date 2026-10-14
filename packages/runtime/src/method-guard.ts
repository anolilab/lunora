/**
 * The one "wrong HTTP method" guard shared by the internal route handlers
 * (health/readiness probes, the public REST surface, and the data-movement admin
 * routes). Centralizing it ensures every 405 carries a correct `Allow` header —
 * the data-movement routes previously threw a `405` with none — while each call
 * site keeps its own allowed-method set unchanged.
 */
import { LunoraError } from "./errors";

/**
 * Enforce that `request.method` is one of `allowed`. Returns a `405` {@link Response}
 * with an `Allow` header listing the permitted methods when it is not, or `undefined`
 * when the method is permitted (the caller proceeds).
 */
const methodGuard = (request: Request, allowed: ReadonlyArray<string>): Response | undefined =>
    allowed.includes(request.method) ? undefined : new Response(undefined, { headers: { allow: allowed.join(", ") }, status: 405 });

/**
 * The throwing sibling of {@link methodGuard} for the admin routes that report a
 * wrong method as a coded error body (no `Allow` header — that wire shape is
 * theirs already): throws the standard 405 `LunoraError` unless the request uses
 * `method`. `label` names the endpoint (`"<label> endpoint requires <method>"`).
 */
const assertMethod = (request: Request, method: "GET" | "POST", label: string): void => {
    if (request.method !== method) {
        throw new LunoraError(`${label} endpoint requires ${method}`, { code: "METHOD_NOT_ALLOWED", status: 405 });
    }
};

export { assertMethod, methodGuard };
