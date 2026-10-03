import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";
import { rateLimit } from "./guards";

/**
 * Grouped application errors — the read/triage surface for the Cloud
 * Observability "Issues" view. Rows are written by the telemetry ingest
 * (`lunora/telemetry.ts`), which fingerprints each error event and folds it onto
 * one issue per (org, hash). These functions back the hosted dashboard and are
 * members-only (the write path is deploy-key authorized, in `telemetry.ts`).
 */

const issueStatus = v.union(v.literal("open"), v.literal("resolved"));

/** A grouped-error row as the dashboard consumes it. */
interface IssueRow {
    _id: Id<"issues">;
    count: number;
    culprit: string;
    firstSeen: number;
    hash: string;
    lastSeen: number;
    organizationId: Id<"organizations">;
    sampleMessage: string;
    sampleTraceId?: string;
    status: "open" | "resolved";
    title: string;
}

/** An org's issues, most-recently-seen first (any member). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<IssueRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.issues.findMany({ where: { organizationId } });

    return page.toSorted((a, b) => b.lastSeen - a.lastSeen);
});

/** Resolve or reopen an issue (owners/admins). */
export const setStatus = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("issues"), organizationId: v.id("organizations"), status: issueStatus })
    .mutation(async ({ ctx: context, args: { id, organizationId, status } }): Promise<Id<"issues">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "issue");
        await context.db.patch(id, { status, updatedAt: context.now });

        return id;
    });
