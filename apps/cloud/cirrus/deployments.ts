import { CirrusError } from "@cirrus/server";

import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";

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

const assertSignedIn = (userId: null | string): string => {
    if (!userId) {
        throw new CirrusError("UNAUTHORIZED", "not signed in");
    }

    return userId;
};

/** A project's deployments, newest first. */
export const listByProject = query({
    args: { projectId: v.id("projects") },
    handler: async (context, { projectId }): Promise<DeploymentRow[]> => {
        assertSignedIn(context.auth.userId);

        const { page } = await context.db.deployments.findMany({ where: { projectId } });

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
        const userId = assertSignedIn(context.auth.userId);
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
 * → failed). Called by the deploy orchestrator as it works through the
 * provisioner's NDJSON progress events.
 */
export const updateStatus = mutation({
    args: {
        bundleHash: v.optional(v.string()),
        id: v.id("deployments"),
        status: v.union(v.literal("queued"), v.literal("provisioning"), v.literal("building"), v.literal("live"), v.literal("failed"), v.literal("destroyed")),
        url: v.optional(v.string()),
    },
    handler: async (context, { bundleHash, id, status, url }): Promise<void> => {
        assertSignedIn(context.auth.userId);

        await context.db.patch(id, {
            ...(bundleHash === undefined ? {} : { bundleHash }),
            ...(url === undefined ? {} : { url }),
            status,
            updatedAt: Date.now(),
        });
    },
});
