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

const stripTrailingSlashes = (value: string): string => {
    let result = value;

    while (result.endsWith("/")) {
        result = result.slice(0, -1);
    }

    return result;
};

export const proxyAdminRequest = async (request: AdminProxyRequest, deps: AdminProxyDeps): Promise<Response> => {
    await deps.authorize(request.organizationId);

    const target = await deps.resolveTarget(request.organizationId, request.deploymentId);

    if (!target) {
        return json(404, { error: "deployment not found" });
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
