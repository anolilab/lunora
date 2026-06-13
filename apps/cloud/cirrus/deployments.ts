import { CirrusError } from "@cirrus/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";

interface DeploymentRow {
    _id: Id<"deployments">;
    branch?: string;
    bundleHash?: string;
    createdAt: number;
    createdBy: string;
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
 * Record a new deployment in the `queued` state. The actual provisioning —
 * bundle upload + per-tenant binding creation via the Alchemy provisioner
 * (`src/provision`), paced by the per-cell scheduler (§2.5) — is driven
 * separately and reports progress back through `updateStatus`.
 */
export const create = mutation({
    args: {
        branch: v.optional(v.string()),
        kind: v.union(v.literal("production"), v.literal("preview"), v.literal("dev")),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        scriptName: v.string(),
    },
    handler: async (context, arguments_): Promise<Id<"deployments">> => {
        const { userId } = await assertMember(context, arguments_.organizationId, ["owner", "admin", "member"]);

        // Integrity: the project must belong to the same org (no cross-org linkage).
        const { page } = await context.db.projects.findMany({ where: { organizationId: arguments_.organizationId } });

        if (!(page as unknown as ProjectRow[]).some((project) => project._id === arguments_.projectId)) {
            throw new CirrusError("NOT_FOUND", "project not found in this organization");
        }

        const now = Date.now();

        return context.db.insert("deployments", {
            branch: arguments_.branch,
            createdAt: now,
            createdBy: userId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            projectId: arguments_.projectId,
            scriptName: arguments_.scriptName,
            status: "queued",
            updatedAt: now,
        });
    },
});

/**
 * Advance a deployment's lifecycle (queued → provisioning → building → live, or
 * → failed). Driven by the deploy orchestrator as it works through the
 * provisioner's progress events.
 *
 * SYSTEM mutation: this is the seam the platform's deploy orchestrator calls,
 * not a user action. It should become an `internalMutation` invoked behind the
 * deploy API with a system identity; until that path exists it is gated by
 * membership in the deployment's org.
 */
export const updateStatus = mutation({
    args: {
        bundleHash: v.optional(v.string()),
        id: v.id("deployments"),
        status: v.union(v.literal("queued"), v.literal("provisioning"), v.literal("building"), v.literal("live"), v.literal("failed"), v.literal("destroyed")),
        url: v.optional(v.string()),
    },
    handler: async (context, { bundleHash, id, status, url }): Promise<void> => {
        const existing = (await context.db.get(id)) as DeploymentRow | null;

        if (!existing) {
            throw new CirrusError("NOT_FOUND", "deployment not found");
        }

        await assertMember(context, existing.organizationId);

        await context.db.patch(id, {
            ...(bundleHash === undefined ? {} : { bundleHash }),
            ...(url === undefined ? {} : { url }),
            status,
            updatedAt: Date.now(),
        });
    },
});
