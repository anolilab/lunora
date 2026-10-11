import { internal } from "../../../lunora/_generated/internal";
import { exportTenantSnapshot, TenantAdminError, tenantSender } from "../../backup/tenant-transport";
import type { StoredAdminToken } from "../admin-token";
import { resolveAdminToken } from "../admin-token";
import type { RouterEnv } from "./shared";
import { jsonError, otlpBearer, rejected, requireContext } from "./shared";

/** The `POST /v1/eject` body — which deployment to package. */
interface EjectBody {
    deploymentId?: string;
}

/**
 * `POST /v1/eject` — the no-lock-in exit hatch, over a deploy key (GAPS.md D2).
 *
 * Returns the deployment's data snapshot together with the identity the BYO
 * `wrangler.jsonc` is named after, so `lunora cloud eject` can write a complete,
 * runnable package from one round trip. The CLI does the scaffolding: the files
 * land on the user's disk, so the templates belong on the user's side.
 *
 * Deploy-key authorized, unlike the studio's session-gated `/v1/admin` proxy —
 * ejecting is something you do from a terminal, and requiring a browser session
 * for the exit hatch would undercut the promise it exists to keep. The org comes
 * from the verified key, never from the body, so a caller cannot name another
 * org's deployment.
 *
 * The snapshot is buffered into the JSON response. That bounds this to exports
 * that fit in a Worker's memory; a streaming form (or a signed R2 hand-off) is
 * the upgrade if real snapshots outgrow it.
 */
export const handleEjectRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const key = otlpBearer(request);

    if (key === undefined) {
        return jsonError(401, "missing Authorization: Bearer <deploy key>");
    }

    const body = (await request.json().catch(() => null)) as EjectBody | null;

    if (!body?.deploymentId) {
        return jsonError(400, "deploymentId is required");
    }

    // The key is authorized INSIDE `ejectTarget`, against the deployment's own org
    // and project — it rejects a revoked key, a telemetry-only ingest key, and a
    // key scoped to another project. Resolving the org here first would repeat the
    // mistake this route shipped with: `orgForDeployKey` exists for the OTLP
    // endpoints and deliberately accepts ANY live key, which made a full tenant
    // export reachable from an ingest token.
    let target: (StoredAdminToken & { organizationId: string; projectSlug: string; scriptName: string; url: string }) | null;

    try {
        target = await context.runQuery(internal.deployments.ejectTarget, { deployKey: key, deploymentId: body.deploymentId });
    } catch (error) {
        return rejected(error, "eject denied");
    }

    if (!target) {
        return jsonError(404, "no live deployment with that id");
    }

    // Decrypt the sealed admin token at the edge, exactly as the studio proxy does.
    const adminToken = await resolveAdminToken(target, environment.SECRET_ENCRYPTION_KEY);

    if (!adminToken) {
        return jsonError(409, "deployment has no usable admin token");
    }

    // The same export the tenant backups read (src/backup/tenant-transport). Over
    // the public URL rather than the driver's in-network `reach`: the exit hatch
    // reads the tenant exactly as its owner's own tooling would.
    let snapshot: string;

    try {
        const exported = await exportTenantSnapshot(tenantSender({ adminToken, url: target.url }));

        snapshot = await new Response(exported).text();
    } catch (error) {
        return jsonError(502, error instanceof TenantAdminError ? error.message : "tenant export failed");
    }

    await context.runMutation(internal.audit_log.record, { action: "deployment.eject", organizationId: target.organizationId });

    return Response.json(
        { projectSlug: target.projectSlug, scriptName: target.scriptName, snapshot, url: target.url },
        { headers: { "content-type": "application/json" }, status: 200 },
    );
};
