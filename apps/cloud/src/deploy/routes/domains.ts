/**
 * Custom domains (GAPS.md B1), under the caller's session:
 *
 * - `POST /v1/domains` — add a hostname to a project.
 * - `POST /v1/domains/verify` — run its DNS checks against the project's
 *   placement, record the outcome, and have the placement's driver issue its
 *   certificate (`DomainOps.issue`), recording it with its issuer.
 * - `POST /v1/domains/remove` — release the domain's certificate through the
 *   issuer recorded with it, then delete the domain.
 *
 * Each tells the placement's driver afterwards (`DomainOps.domainsChanged`).
 */
import { api, internal } from "../../../lunora/_generated/api.js";
import { requireIssuer } from "../../domains/issuers";
import { createDohResolver, verifyDomain } from "../../domains/verify";
import type { DomainCertificate, TargetDriver } from "../../targets/driver";
import { registeredFleet, resolveTargetDriver } from "../../targets/registry";
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
    certificateIssuer?: null | string;
    customHostnameId?: null | string;
    hostname: string;
    projectId: string; // secret-scanner:allow -- domain field name
    txtToken: string;
}

/** What removing a domain must release first (`internal.domains.removalTarget`). */
interface RemovalTarget {
    certificateIssuer?: string;
    certificateScope?: string;
    customHostnameId?: string;
    hostname: string;
    projectId: string; // secret-scanner:allow -- domain field name
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The driver of a project's placement, built once per request. */
const driverFor = async (
    context: ReturnType<typeof requireContext>,
    environment: RouterEnv,
    organizationId: string,
    projectId: string,
): Promise<TargetDriver> => resolveTargetDriver(await placementFor(context, environment, organizationId, projectId), environment);

/**
 * Tell the placement's driver its project's domains changed, best-effort:
 * the request already did what it was asked, so a failure is only logged —
 * the target catches up at its next sync.
 */
const notifyDomainsChanged = async (driver: TargetDriver | undefined, hostname: string): Promise<void> => {
    try {
        await driver?.domains.domainsChanged?.();
    } catch (error) {
        // eslint-disable-next-line no-console -- the request already succeeded; nothing else can carry this
        console.warn("[domains]", `${hostname} changed, but its target could not be told: ${messageOf(error)}`);
    }
};

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

    let result: { id: string; txtName: string; txtToken: string };

    try {
        result = await context.runMutation<{ id: string; txtName: string; txtToken: string }>(api.domains.add, {
            hostname: body.hostname,
            organizationId: body.organizationId,
            projectId: body.projectId, // secret-scanner:allow -- domain field name
            redirectStatusCode: body.redirectStatusCode,
            redirectTo: body.redirectTo,
        });
    } catch (error) {
        return rejected(error, "domain add failed");
    }

    const driver = await driverFor(context, environment, body.organizationId, body.projectId).catch(() => undefined);

    await notifyDomainsChanged(driver, body.hostname);

    return Response.json(result);
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
        const driver = await driverFor(context, environment, body.organizationId, domain.projectId);
        const result = await verifyDomain(domain.hostname, {
            platformTargets: driver.domains.platformTargets(),
            resolve: createDohResolver(),
            txtToken: domain.txtToken,
        });

        await context.runMutation(internal.domains.markVerified, { id: body.id, organizationId: body.organizationId, verified: result.verified });

        // The domain is verified either way; a certificate the issuer refused is
        // recorded on the row (and retried by the next verify), never a failed verify.
        let certificate: DomainCertificate | undefined;

        if (result.verified) {
            try {
                certificate = await driver.domains.issue({
                    // Only a certificate this same target issued is its to re-read.
                    ...(domain.customHostnameId == null || domain.certificateIssuer !== driver.id ? {} : { customHostnameId: domain.customHostnameId }),
                    hostname: domain.hostname,
                });
            } catch (error) {
                certificate = { error: messageOf(error).slice(0, 256), sslStatus: "failed" };
            }
        }

        if (certificate !== undefined) {
            const issued = certificate.customHostnameId !== undefined && certificate.scope !== undefined;

            await context.runMutation(internal.domains.recordCertificate, {
                ...(issued ? { customHostnameId: certificate.customHostnameId, issuer: driver.id, scope: certificate.scope } : {}),
                ...(certificate.error === undefined ? {} : { error: certificate.error }),
                id: body.id,
                organizationId: body.organizationId,
                sslStatus: certificate.sslStatus,
            });
        }

        await notifyDomainsChanged(driver, domain.hostname);

        return Response.json({ ...result, ...(certificate === undefined ? {} : { certificate }) });
    } catch (error) {
        return rejected(error, "domain verification failed");
    }
};

/**
 * `POST /v1/domains/remove` — remove a domain under the caller's session
 * (owner/admin). Its certificate is released first, through the issuer
 * recorded with it (`cloudflare-wfp`: its Cloudflare-for-SaaS custom hostname)
 * — whatever the project's target is now; if that fails the domain stays, so no
 * certificate outlives its row, and the caller retries.
 */
export const handleDomainRemoveRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as DomainBody | null;

    if (!body?.id || !body.organizationId) {
        return jsonError(400, "id and organizationId are required");
    }

    let target: RemovalTarget;

    try {
        target = await context.runQuery<RemovalTarget>(internal.domains.removalTarget, { id: body.id, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "domain removal refused");
    }

    // Resolved once, for `domainsChanged` afterwards. A project whose placement no
    // longer resolves (a revoked box, say) still loses its domain: nothing serves it.
    const driver = await driverFor(context, environment, body.organizationId, target.projectId).catch(() => undefined);

    if (target.customHostnameId !== undefined) {
        try {
            await requireIssuer(target, (id) => registeredFleet(id, environment)).release(target.customHostnameId);
        } catch (error) {
            return jsonError(502, `could not release this domain's certificate, so it was kept; try again: ${messageOf(error)}`);
        }
    }

    try {
        await context.runMutation(internal.domains.remove, { id: body.id, organizationId: body.organizationId });
    } catch (error) {
        return rejected(error, "domain removal failed");
    }

    await notifyDomainsChanged(driver, target.hostname);

    return Response.json({ ok: true });
};
