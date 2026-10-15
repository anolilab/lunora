import { internal } from "../../../lunora/_generated/internal";
import { proxyAdminRequest } from "../../admin/proxy";
import type { StoredAdminToken } from "../admin-token";
import { resolveAdminToken } from "../admin-token";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

interface AdminBody {
    body?: unknown;
    deploymentId?: string;
    method?: string;
    organizationId?: string;
    path?: string;
}

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
export const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const adminBody = (await request.json().catch(() => null)) as AdminBody | null;

    if (!adminBody?.organizationId || !adminBody.deploymentId || !adminBody.path) {
        return jsonError(400, "organizationId, deploymentId and path are required");
    }

    // The target is resolved for this path: `adminTarget` decides the role from it.
    const adminPath = adminBody.path;

    try {
        return await proxyAdminRequest(
            {
                body: adminBody.body,
                deploymentId: adminBody.deploymentId,
                method: adminBody.method ?? "GET",
                organizationId: adminBody.organizationId,
                path: adminBody.path,
            },
            {
                authorize: () => Promise.resolve(), // membership is asserted by `adminTarget`
                recordAudit: async (entry) => {
                    await context.runMutation(internal.audit_log.record, { action: entry.action, organizationId: entry.organizationId });
                },
                resolveTarget: async (organizationId, deploymentId) => {
                    const target = await context.runQuery<(StoredAdminToken & { url: string }) | null>(internal.deployments.adminTarget, {
                        adminPath,
                        deploymentId,
                        organizationId,
                    });

                    if (!target) {
                        return null;
                    }

                    // Decrypt the sealed admin token at the edge (never over RPC).
                    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

                    return adminToken ? { adminToken, url: target.url } : null;
                },
            },
        );
    } catch (error) {
        return rejected(error, "admin request denied");
    }
};
