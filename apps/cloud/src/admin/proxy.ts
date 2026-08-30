/**
 * Hosted-studio admin-RPC proxy (CLOUD-PLAN.md §3). The hosted dashboard never
 * talks to a tenant Worker directly; it goes through this proxy, which (1)
 * authorizes the caller's org membership, (2) forwards the admin RPC to the
 * tenant's `/_lunora/admin/*` with that deployment's admin token, and (3) records
 * an audit entry. Pure — all I/O is injected, so it's unit-testable with fakes.
 */

export interface AdminProxyTarget {
    /** The tenant deployment's admin bearer token. */
    adminToken: string;
    /** The tenant deployment's base URL. */
    url: string;
}

export interface AdminProxyRequest {
    body?: unknown;
    deploymentId: string;
    method: string;
    organizationId: string;
    /** Admin sub-path, e.g. `functions` → `/_lunora/admin/functions`. */
    path: string;
}

export interface AdminProxyDeps {
    /** Authorize the caller for the org; throws (FORBIDDEN/UNAUTHORIZED) if not. */
    authorize: (organizationId: string) => Promise<void>;
    fetch?: typeof globalThis.fetch;
    /** Append an audit-log entry for the proxied admin action. */
    recordAudit: (entry: { action: string; organizationId: string }) => Promise<void>;
    /** Resolve the target deployment's URL + admin token, or null if unknown. */
    resolveTarget: (organizationId: string, deploymentId: string) => Promise<AdminProxyTarget | null>;
}

const json = (status: number, data: unknown): Response => Response.json(data, { headers: { "content-type": "application/json" }, status });

/**
 * Trim trailing slashes before joining a path onto a base URL.
 *
 * A loop rather than a `/\/+$/` replace: a greedy trailing-quantifier regex on
 * attacker-influenced input is the classic backtracking shape, and this runs on
 * every proxied admin request. Exported so the eject route joins its tenant URL
 * exactly the same way.
 */
export const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

/**
 * Path segments the admin proxy will forward, and the verbs it will use.
 *
 * An allow-list of SHAPE rather than of names: the tenant's admin surface grows
 * with the framework, so enumerating routes here would silently break new ones.
 * What must never vary is that the value stays inside `/_lunora/admin/` — one or
 * more `a-z0-9_-` segments, no dots, no scheme, no query.
 */
const ADMIN_PATH = /^[\w-]+(?:\/[\w-]+)*$/iu;

/** Verbs the studio's admin surface uses. Anything else is a write nobody asked for. */
const ADMIN_METHODS = new Set(["GET", "POST"]);

/** Whether a caller-supplied admin path is safe to append to the tenant's admin base. */
const isAdminPath = (path: string): boolean => path.length > 0 && path.length <= 200 && ADMIN_PATH.test(path);

export const proxyAdminRequest = async (request: AdminProxyRequest, deps: AdminProxyDeps): Promise<Response> => {
    await deps.authorize(request.organizationId);

    const target = await deps.resolveTarget(request.organizationId, request.deploymentId);

    if (!target) {
        return json(404, { error: "deployment not found" });
    }

    // The path and method are CALLER-SUPPLIED, and this request carries the
    // tenant's own admin bearer — so an unvalidated `path` is not a routing
    // detail, it is a confused deputy. `..` segments normalise away inside the URL
    // parser, so `../../x` escaped `/_lunora/admin/` and reached any route on the
    // tenant Worker authenticated as the platform; a caller-chosen verb then
    // decided whether that was a read or a write.
    if (!isAdminPath(request.path)) {
        return json(400, { error: "invalid admin path" });
    }

    if (!ADMIN_METHODS.has(request.method)) {
        return json(405, { error: "method not allowed" });
    }

    const fetchImpl = deps.fetch ?? globalThis.fetch;
    const response = await fetchImpl(`${stripTrailingSlashes(target.url)}/_lunora/admin/${request.path}`, {
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        headers: { authorization: `Bearer ${target.adminToken}`, "content-type": "application/json" },
        method: request.method,
    });

    await deps.recordAudit({ action: `admin.${request.path}`, organizationId: request.organizationId });

    return response;
};
