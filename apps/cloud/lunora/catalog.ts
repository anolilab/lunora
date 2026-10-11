import { LunoraError } from "@lunora/server";

import { RELEASE_LEASE_MS } from "../src/deploy/lease";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * App catalog installs. The install route claims a project before it writes
 * anything (`claimInstall`), marks the claim live once the release is up
 * (`finishInstall`), and gives it up when the install fails (`abandonInstall`).
 * Members read the org's live installs through `installs`.
 */

/** A claim older than this is a crashed install and no longer blocks its project. Matches the release-key lease. */

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
    activeKey?: string;
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

        const rows = await collectAll<InstallRow>((cursor) => context.db.catalogInstalls.findMany({ cursor, where: { organizationId } }));

        return rows
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
 * dropped.
 *
 * The check is a read and the claim is an insert, so two claims can both read an
 * empty project. The unique `by_active` index is what makes the claim exclusive: the
 * insert fails for the second one, which then reports busy. The stored key is
 * the project id, and a live install gives its key up in `finishInstall`.
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
        const holderOf = async (): Promise<InstallRow | undefined> => {
            const { page } = await context.db.catalogInstalls.findMany({ where: { activeKey: args.projectId } });

            return (page as unknown as InstallRow[]).at(0);
        };

        const holder = await holderOf();

        if (holder !== undefined) {
            if (context.now - holder.createdAt < RELEASE_LEASE_MS) {
                return { busy: true };
            }

            await context.db.delete(holder._id);
        }

        try {
            const installId = await context.db.insert("catalogInstalls", {
                ...args,
                activeKey: args.projectId,
                createdAt: context.now,
                status: "installing",
            });

            return { busy: false, installId };
        } catch (error) {
            // The unique key refused the insert: another claim landed between the read and this write.
            if ((await holderOf()) !== undefined) {
                return { busy: true };
            }

            throw error;
        }
    });

/** Mark a claim live once its release is up (SYSTEM). */
export const finishInstall = internalMutation
    .input({ deploymentId: boundedString(LIMITS.id), installId: v.id("catalogInstalls") })
    .mutation(async ({ ctx: context, args: { deploymentId, installId } }): Promise<void> => {
        const row = (await context.db.get(installId)) as InstallRow | null;

        if (row?.status !== "installing") {
            throw new LunoraError("CONFLICT", "no install is in progress for this claim");
        }

        // A live row keys on its own install id, so no claim on the project can match it.
        await context.db.patch(installId, { activeKey: `live:${installId}`, deploymentId, status: "live" });
        // Keep the install's provenance on its release, so a rollback back onto it can show the badge again.
        await context.db.patch(deploymentId as Id<"deployments">, {
            catalogInstalledBy: row.installedBy,
            catalogSlug: row.slug,
            catalogVersion: row.version,
        });

        // A project runs one production release, so the new live row replaces every earlier one.
        const rows = await collectAll<InstallRow>((cursor) => context.db.catalogInstalls.findMany({ cursor, where: { projectId: row.projectId } }));

        for (const other of rows) {
            if (other._id !== installId && other.status === "live") {
                // eslint-disable-next-line no-await-in-loop -- a handful of superseded releases per project
                await context.db.delete(other._id);
            }
        }
    });

/**
 * How long before its lease ends a claim stops counting as held. An install that is
 * still running at this point stops writing (its rollback is skipped), so a takeover
 * that becomes possible at the lease's end never overlaps its writes by much.
 */
const CLAIM_FENCE_MARGIN_MS = 5 * 60 * 1000;

/**
 * Whether an install still holds its project's claim (SYSTEM). A claim taken over
 * after its lease is deleted, so a takeover is visible as a missing row: the old
 * install's row id never comes back, which makes this a generation check. A claim
 * within the fence margin of its lease's end is treated as lost.
 */
export const holdsClaim = internalQuery.input({ installId: v.id("catalogInstalls") }).query(async ({ ctx: context, args: { installId } }): Promise<boolean> => {
    const row = (await context.db.get(installId)) as InstallRow | null;

    return row?.status === "installing" && context.now - row.createdAt < RELEASE_LEASE_MS - CLAIM_FENCE_MARGIN_MS;
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
