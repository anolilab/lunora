import { CirrusError } from "@cirrus/server";

import { previewExpiry } from "../src/deploy/preview";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeDeployKey } from "./authz";

interface DeploymentRow {
    _id: Id<"deployments">;
    branch?: string;
    bundleHash?: string;
    createdAt: number;
    createdBy: string;
    expiresAt?: number;
    kind: "dev" | "preview" | "production";
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    scriptName: string;
    status: "building" | "destroyed" | "failed" | "live" | "provisioning" | "queued";
    updatedAt: number;
    url?: string;
}

interface ProjectRow {
    _id: Id<"projects">;
}

/** A project's deployments, newest first. Caller must be a member of the org. */
export const listByProject = query({
    args: { organizationId: v.id("organizations"), projectId: v.id("projects") },
    handler: async (context, { organizationId, projectId }): Promise<DeploymentRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.deployments.findMany({ where: { organizationId, projectId } });

        return (page as unknown as DeploymentRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
    },
});

/**
 * Record a new deployment in the `queued` state. Authorized either by a member
 * session (dashboard) or a valid `deployKey` (CI; §2.2). The actual provisioning
 * — bundle upload + per-tenant binding creation via the Alchemy provisioner
 * (`src/provision`), paced by the per-cell scheduler (§2.5) — is driven
 * separately and reports progress back through `updateStatus`.
 */
export const create = mutation({
    args: {
        branch: v.optional(v.string()),
        // CI deploy path: a valid deploy key authorizes in lieu of a member session.
        deployKey: v.optional(v.string()),
        kind: v.union(v.literal("production"), v.literal("preview"), v.literal("dev")),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        scriptName: v.string(),
    },
    handler: async (context, arguments_): Promise<Id<"deployments">> => {
        let createdBy: string;

        if (arguments_.deployKey) {
            const deployKeyId = await authorizeDeployKey(context, arguments_.organizationId, arguments_.deployKey, arguments_.projectId);

            createdBy = `deploy-key:${deployKeyId}`;
        } else {
            const member = await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

            createdBy = member.userId;
        }

        // Integrity: the project must belong to the same org (no cross-org linkage).
        const { page } = await context.db.projects.findMany({ where: { organizationId: arguments_.organizationId } });

        if (!(page as unknown as ProjectRow[]).some((project) => project._id === arguments_.projectId)) {
            throw new CirrusError("NOT_FOUND", "project not found in this organization");
        }

        const now = Date.now();

        return context.db.insert("deployments", {
            branch: arguments_.branch,
            createdAt: now,
            createdBy,
            // Previews are TTL'd; the cleanup cron tears down expired ones (§2.3).
            ...(arguments_.kind === "preview" ? { expiresAt: previewExpiry(now) } : {}),
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name, not a Cypress projectId
            scriptName: arguments_.scriptName,
            status: "queued",
            updatedAt: now,
        });
    },
});

/**
 * Mark expired preview deployments as `destroyed` (CLOUD-PLAN.md §2.3). Driven
 * by the cleanup cron (`cirrus/crons.ts`); `internalMutation` so it is reachable
 * only via the cron's system dispatch, never from a client. The actual
 * Cloudflare teardown is the provisioner's `destroy` (orchestrator) — wired once
 * Alchemy lands; this records the lifecycle transition.
 */
export const cleanupExpiredPreviews = internalMutation({
    args: {},
    handler: async (context): Promise<{ destroyed: number }> => {
        const now = Date.now();
        const { page } = await context.db.deployments.findMany({ where: { kind: "preview" } });

        const expired = (page as unknown as DeploymentRow[]).filter(
            (deployment) => deployment.status !== "destroyed" && deployment.expiresAt !== undefined && deployment.expiresAt < now,
        );

        for (const deployment of expired) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(deployment._id, { status: "destroyed", updatedAt: now });
        }

        return { destroyed: expired.length };
    },
});

/**
 * Advance a deployment's lifecycle (queued → provisioning → building → live, or
 * → failed). Driven by the deploy orchestrator as it works through the
 * provisioner's progress events, authorized by the same `deployKey` (CI) or a
 * member session (dashboard).
 *
 * Kept a public `mutation` deliberately: the deploy endpoint reaches it through
 * the HTTP action context's `ctx.runMutation`, whose dispatch carries no
 * system-dispatch flag — so an `internalMutation` would be unreachable from that
 * seam (it would 404 at the RPC visibility gate). Authorization is enforced
 * here instead (deploy key or org membership).
 */
export const updateStatus = mutation({
    args: {
        bundleHash: v.optional(v.string()),
        deployKey: v.optional(v.string()),
        id: v.id("deployments"),
        status: v.union(v.literal("queued"), v.literal("provisioning"), v.literal("building"), v.literal("live"), v.literal("failed"), v.literal("destroyed")),
        url: v.optional(v.string()),
    },
    handler: async (context, { bundleHash, deployKey, id, status, url }): Promise<void> => {
        const existing = (await context.db.get(id)) as DeploymentRow | null;

        if (!existing) {
            throw new CirrusError("NOT_FOUND", "deployment not found");
        }

        await (deployKey
            ? authorizeDeployKey(context, existing.organizationId, deployKey, existing.projectId)
            : assertMember(context, existing.organizationId));

        await context.db.patch(id, {
            ...(bundleHash === undefined ? {} : { bundleHash }),
            ...(url === undefined ? {} : { url }),
            status,
            updatedAt: Date.now(),
        });
    },
});
