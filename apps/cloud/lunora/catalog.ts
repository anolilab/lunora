import { LunoraError } from "@lunora/server";

import type { Id } from "./_generated/dataModel.js";
import { internalMutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { boundedString, LIMITS } from "./validators";

/**
 * App catalog installs. The install route claims a project before it writes
 * anything (`claimInstall`), marks the claim live once the release is up
 * (`finishInstall`), and gives it up when the install fails (`abandonInstall`).
 * Members read the org's live installs through `installs`.
 */

/** A claim older than this is a crashed install and no longer blocks its project. Matches the release-key lease. */
const CLAIM_LEASE_MS = 35 * 60 * 1000;

/** One live install, as the catalog listing reads it. */
export interface CatalogInstallView {
    _id: string;
    createdAt: number;
    deploymentId: string;
    installedBy: string;
    organizationId: string;
    projectId: string;
    slug: string;
    version: string;
}

interface InstallRow {
    _id: Id<"catalogInstalls">;
    createdAt: number;
    deploymentId?: string;
    installedBy: string;
    organizationId: Id<"organizations">;
    projectId: Id<"projects">;
    slug: string;
    status: "installing" | "live";
    version: string;
}

/** The org's live catalog installs, newest first. Any member may read them. */
export const installs = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<CatalogInstallView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.catalogInstalls.findMany({ where: { organizationId } });

        return (page as unknown as InstallRow[])
            .filter((row) => row.status === "live" && row.deploymentId !== undefined)
            .toSorted((a, b) => b.createdAt - a.createdAt)
            .map((row) => {
                return {
                    _id: row._id,
                    createdAt: row.createdAt,
                    deploymentId: row.deploymentId ?? "",
                    installedBy: row.installedBy,
                    organizationId: row.organizationId,
                    projectId: row.projectId,
                    slug: row.slug,
                    version: row.version,
                };
            });
    });

/**
 * Claim a project for one install (SYSTEM). Refuses while another install of the
 * project holds a live claim; a claim past its lease is a crashed install and is
 * dropped. Lunora mutations on one shard are serialized, so the check and the
 * insert are one step.
 */
export const claimInstall = internalMutation
    .input({
        installedBy: boundedString(LIMITS.id),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
        slug: boundedString(LIMITS.name),
        version: boundedString(LIMITS.id),
    })
    .mutation(async ({ ctx: context, args }): Promise<{ busy: true } | { busy: false; installId: string }> => {
        const { page } = await context.db.catalogInstalls.findMany({ where: { projectId: args.projectId } });

        for (const row of page as unknown as InstallRow[]) {
            if (row.status !== "installing") {
                continue;
            }

            if (context.now - row.createdAt < CLAIM_LEASE_MS) {
                return { busy: true };
            }

            // eslint-disable-next-line no-await-in-loop -- a handful of stale claims per project
            await context.db.delete(row._id);
        }

        const installId = await context.db.insert("catalogInstalls", { ...args, createdAt: context.now, status: "installing" });

        return { busy: false, installId };
    });

/** Mark a claim live once its release is up (SYSTEM). */
export const finishInstall = internalMutation
    .input({ deploymentId: boundedString(LIMITS.id), installId: v.id("catalogInstalls") })
    .mutation(async ({ ctx: context, args: { deploymentId, installId } }): Promise<void> => {
        const row = (await context.db.get(installId)) as InstallRow | null;

        if (row?.status !== "installing") {
            throw new LunoraError("CONFLICT", "no install is in progress for this claim");
        }

        await context.db.patch(installId, { deploymentId, status: "live" });

        // A project runs one production release, so the new live row replaces every earlier one.
        const { page } = await context.db.catalogInstalls.findMany({ where: { projectId: row.projectId } });

        for (const other of page as unknown as InstallRow[]) {
            if (other._id !== installId && other.status === "live") {
                // eslint-disable-next-line no-await-in-loop -- a handful of superseded releases per project
                await context.db.delete(other._id);
            }
        }
    });

/** Give up a claim whose install did not go live (SYSTEM). */
export const abandonInstall = internalMutation
    .input({ installId: v.id("catalogInstalls") })
    .mutation(async ({ ctx: context, args: { installId } }): Promise<void> => {
        const row = (await context.db.get(installId)) as InstallRow | null;

        if (row?.status === "installing") {
            await context.db.delete(installId);
        }
    });
