/**
 * Custom domains (GAPS.md B1), under the caller's session:
 *
 * - `POST /v1/domains` — add a hostname to a project.
 * - `POST /v1/domains/verify` — run its DNS checks against the project's
 *   placement, record the outcome, and run the driver's `onVerified` hook,
 *   recording the certificate it requested.
 * - `POST /v1/domains/remove` — release the domain's certificate through the
 *   driver's `onRemoved` hook, then delete the domain.
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import { createDohResolver, verifyDomain } from "../../domains/verify";
import type { DomainCertificate, DomainOps } from "../../targets/driver";
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
    customHostnameId?: null | string;
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

        if (!result.verified || domains.onVerified === undefined) {
            return Response.json(result);
        }

        // The domain is verified either way; a certificate the issuer refused is
        // recorded on the row (and retried by the next verify), never a failed verify.
        let certificate: DomainCertificate | undefined;

        try {
            certificate = await domains.onVerified({
                ...(domain.customHostnameId == null ? {} : { customHostnameId: domain.customHostnameId }),
                hostname: domain.hostname,
            });
        } catch (error) {
            certificate = { error: (error instanceof Error ? error.message : String(error)).slice(0, 256), sslStatus: "failed" };
        }

        if (certificate !== undefined) {
            await context.runMutation(internal.domains.recordCertificate, {
                ...(certificate.customHostnameId === undefined ? {} : { customHostnameId: certificate.customHostnameId }),
                ...(certificate.error === undefined ? {} : { error: certificate.error }),
                id: body.id,
                organizationId: body.organizationId,
                sslStatus: certificate.sslStatus,
            });
        }

        return Response.json({ ...result, ...(certificate === undefined ? {} : { certificate }) });
    } catch (error) {
        return rejected(error, "domain verification failed");
    }
};

/**
 * `POST /v1/domains/remove` — remove a domain under the caller's session
 * (owner/admin). The project's target releases what it set up for the domain
 * first (`cloudflare-wfp`: its Cloudflare-for-SaaS custom hostname and
 * certificate); if that fails the domain stays, so no certificate outlives its
 * row, and the caller retries.
 */
export const handleDomainRemoveRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.id || !body.organizationId) {
        return jsonError(400, "id and organizationId are required");
    }

    let target: { customHostnameId?: string; hostname: string; projectId: string };

    try {
        target = await context.runQuery(internal.domains.removalTarget, { id: body.id, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "domain removal refused");
    }

    let domains: DomainOps | undefined;

    // Only a domain a target issued a certificate for holds anything outside the control plane.
    if (target.customHostnameId !== undefined) {
        try {
            domains = resolveTargetDriver(await placementFor(context, environment, body.organizationId, target.projectId), environment).domains;

            await domains.onRemoved?.({ customHostnameId: target.customHostnameId, hostname: target.hostname });
        } catch (error) {
            return jsonError(
                502,
                `could not release this domain's certificate, so it was kept; try again: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
    }

    try {
        await context.runMutation(internal.domains.remove, { id: body.id, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "domain removal failed");
    }

    try {
        domains ??= resolveTargetDriver(await placementFor(context, environment, body.organizationId, target.projectId), environment).domains;
        await domains.afterRemoved?.();
    } catch (error) {
        // The row is gone; the target catches up at its next sync, so Workers Logs is the only record.
        // eslint-disable-next-line no-console -- the request already succeeded; nothing else can carry this
        console.warn(
            "[domain-remove]",
            `${target.hostname} removed, but its target could not be told: ${error instanceof Error ? error.message : String(error)}`,
        );
    }

    return Response.json({ ok: true });
};
