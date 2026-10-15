import type { BadgeInstall, InstallBadgeStore } from "../src/catalog/install-badge";
import { endInstallBadge } from "../src/catalog/install-badge";
import type { DeploymentStatus } from "../src/deploy/status-transitions";
import type { Doc as Document_, Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { fireDeployAlerts } from "./alerts";
import { enqueueNotification } from "./notification-outbox";
import { collectAll } from "./paginate";

type DeploymentRow = Document_<"deployments">;

/** The `${status}At` timestamp column stamped on each phase transition (GAPS.md A2). */
export const PHASE_TIMESTAMP: Record<
    DeploymentStatus,
    "destroyedAt" | "failedAt" | "liveAt" | "provisioningAt" | "queuedAt" | "supersededAt" | "verifyingAt" | null
> = {
    building: null,
    destroyed: "destroyedAt",
    failed: "failedAt",
    live: "liveAt",
    provisioning: "provisioningAt",
    queued: "queuedAt",
    superseded: "supersededAt",
    verifying: "verifyingAt",
};

/** The release line a live notification carries: the version and its public URL, nothing else. */
export const releaseDetail = (deployment: DeploymentRow, url: string | undefined): string => {
    const version = deployment.version === undefined ? undefined : `Version ${String(deployment.version)}`;
    const liveUrl = url ?? deployment.url;

    return [version, liveUrl ? `is live at ${liveUrl}.` : "is live."].filter(Boolean).join(" ");
};

/** The project's display name for a notification, falling back when the row is gone. */
export const projectNameOf = async (context: MutationContext, projectId: Id<"projects">): Promise<string> => {
    const project = (await context.db.get(projectId)) as null | { name?: string };

    return project?.name ?? "project";
};

/** The catalog install badge over this mutation's database (`src/catalog/install-badge.ts` holds the rule). */
export const installBadgeOf = (context: MutationContext): InstallBadgeStore => {
    return {
        delete: (id) => context.db.delete(id as Id<"catalogInstalls">),
        insert: async (row) => await context.db.insert("catalogInstalls", row),
        installsOf: (projectId) =>
            collectAll<BadgeInstall>((cursor) => context.db.catalogInstalls.findMany({ cursor, where: { projectId: projectId as Id<"projects"> } })),
        patch: (id, values) => context.db.patch(id as Id<"catalogInstalls">, values),
    };
};

/**
 * The side effects of a deployment entering `status`, run after `updateStatus`
 * has written it. The phase timestamp is stamped in that same write, from
 * `PHASE_TIMESTAMP`. The catalog badge ends, and a failure is announced, only on a
 * crossing into the status, never on a same-status re-write.
 */
export const onEnter = async (context: MutationContext, id: Id<"deployments">, existing: DeploymentRow, status: DeploymentStatus): Promise<void> => {
    if ((status === "superseded" || status === "failed") && existing.status !== status) {
        await endInstallBadge(installBadgeOf(context), existing);
    }

    // Notify the org's `deploy` rules, but only on the transition INTO failed.
    // The orchestrator re-drives this mutation as it works through the
    // provisioner's events, and a deployment that is already failed can be
    // written again by a retry — firing on the state rather than the crossing
    // would page somebody once per attempt for one broken release.
    if (status === "failed" && existing.status !== "failed") {
        const project = (await context.db.get(existing.projectId)) as null | { name: string };

        await fireDeployAlerts(context, existing.organizationId, `deployment:${id}`, {
            detail: `The deployment did not reach a live state. Its last recorded phase was "${existing.status}".`,
            kind: "deployment",
            project: project?.name ?? "project",
            reference: existing.scriptName,
        });

        await enqueueNotification(context, existing.organizationId, "deployment.failed", {
            detail: "Open the deployment in the dashboard for its log.",
            project: await projectNameOf(context, existing.projectId),
        });
    }
};

/** Whether a value parses as an absolute http or https URL. */
export const isWebUrl = (value: string): boolean => {
    try {
        const { protocol } = new URL(value);

        return protocol === "https:" || protocol === "http:";
    } catch {
        return false;
    }
};
