import { internal } from "../../../lunora/_generated/internal";
import { proxyAdminRequest } from "../../admin/proxy";
import type { StoredAdminToken } from "../admin-token";
import { resolveAdminToken } from "../admin-token";
import type { RouterEnv } from "./shared";
import { jsonError, readJsonObject, rejected, requireContext } from "./shared";

/** `POST /v1/admin` — hosted-studio admin proxy to a tenant deployment (§3). */
export const handleAdminRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const adminBody = await readJsonObject(request);
    const organizationId = adminBody?.["organizationId"];
    const deploymentId = adminBody?.["deploymentId"];
    // The target is resolved for this path: `adminTarget` decides the role from it.
    const adminPath = adminBody?.["path"];
    const method = adminBody?.["method"] ?? "GET";

    if (
        typeof organizationId !== "string" ||
        !organizationId ||
        typeof deploymentId !== "string" ||
        !deploymentId ||
        typeof adminPath !== "string" ||
        !adminPath
    ) {
        return jsonError(400, "organizationId, deploymentId and path are required strings");
    }

    if (typeof method !== "string") {
        return jsonError(400, "method, when given, is a string");
    }

    try {
        return await proxyAdminRequest(
            {
                body: adminBody?.["body"],
                deploymentId,
                method,
                organizationId,
                path: adminPath,
            },
            {
                authorize: () => Promise.resolve(), // membership is asserted by `adminTarget`
                recordAudit: async (entry) => {
                    await context.runMutation(internal.audit_log.record, { action: entry.action, organizationId: entry.organizationId });
                },
                resolveTarget: async (targetOrganizationId, targetDeploymentId) => {
                    const target = await context.runQuery<(StoredAdminToken & { url: string }) | null>(internal.deployments.adminTarget, {
                        adminPath,
                        deploymentId: targetDeploymentId,
                        organizationId: targetOrganizationId,
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
