/**
 * Custom domains (GAPS.md B1), under the caller's session:
 *
 * - `POST /v1/domains` — add a hostname to a project.
 * - `POST /v1/domains/verify` — run its DNS checks against the project's
 *   placement, record the outcome, and run the driver's `onVerified` hook.
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import { createDohResolver, verifyDomain } from "../../domains/verify";
import { resolveTargetDriver } from "../../targets/registry";
import { placementFor } from "./deploy";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

interface DomainBody {
    hostname?: string;
    id?: string;
    organizationId?: string;
    projectId?: string; // secret-scanner:allow -- domain field name
    redirectStatusCode?: number;
    redirectTo?: string;
}

interface DomainRowLike {
    hostname: string;
    projectId: string; // secret-scanner:allow -- domain field name
    txtToken: string;
}

/**
 * `POST /v1/domains` — add a hostname to a project under the caller's session
 * (GAPS.md B1). Returns the `_lunora.&lt;host>` TXT record the user must create.
 */
export const handleDomainAddRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.hostname || !body.organizationId || !body.projectId) {
        return jsonError(400, "hostname, organizationId and projectId are required");
    }

    try {
        const result = await context.runMutation<{ id: string; txtName: string; txtToken: string }>(api.domains.add, {
            hostname: body.hostname,
            organizationId: body.organizationId,
            projectId: body.projectId, // secret-scanner:allow -- domain field name
            redirectStatusCode: body.redirectStatusCode,
            redirectTo: body.redirectTo,
        });

        return Response.json(result);
    } catch (error) {
        return rejected(error, "domain add failed");
    }
};

/**
 * `POST /v1/domains/verify` — run the DNS checks for a domain (TXT token +
 * pointing at the platform) and record the outcome (GAPS.md B1). Runs under
 * the caller's session; the DNS lookups use DNS-over-HTTPS at the edge.
 */
export const handleDomainVerifyRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.id || !body.organizationId) {
        return jsonError(400, "id and organizationId are required");
    }

    try {
        const domain = await context.runQuery<DomainRowLike | null>(api.domains.get, { id: body.id, organizationId: body.organizationId });

        if (!domain) {
            return jsonError(404, "domain not found");
        }

        // The CNAME targets are the project's placement's: a box answers on its own hostname, WfP on the apex.
        const { domains } = resolveTargetDriver(await placementFor(context, environment, body.organizationId, domain.projectId), environment);
        const result = await verifyDomain(domain.hostname, {
            platformTargets: domains.platformTargets(),
            resolve: createDohResolver(),
            txtToken: domain.txtToken,
        });

        await context.runMutation(internal.domains.markVerified, { id: body.id, organizationId: body.organizationId, verified: result.verified });

        if (result.verified) {
            await domains.onVerified?.();
        }

        return Response.json(result);
    } catch (error) {
        return rejected(error, "domain verification failed");
    }
};
