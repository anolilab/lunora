import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg } from "./authz";

/**
 * Higher-level incidents (crash-loop / OOM / error-spike) opened from container
 * lifecycle telemetry by the ingest (`lunora/telemetry.ts`). These functions are
 * the read/triage surface for the hosted dashboard (members only); resolving is
 * owner/admin. Auto-resolve on a cleared pattern is a Phase 4 concern.
 */

const incidentStatus = v.union(v.literal("open"), v.literal("resolved"));

/** An incident row as the dashboard consumes it. */
interface IncidentRow {
    _id: Id<"incidents">;
    closedAt?: number;
    container?: string;
    count: number;
    instance?: string;
    kind: "crash_loop" | "error_spike" | "oom";
    lastSeen: number;
    openedAt: number;
    organizationId: Id<"organizations">;
    status: "open" | "resolved";
    title: string;
}

/** An org's incidents, most-recently-seen first (any member). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<IncidentRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.incidents.findMany({ where: { organizationId } });

    return (page as unknown as IncidentRow[]).toSorted((a, b) => b.lastSeen - a.lastSeen);
});

/** Resolve or reopen an incident (owners/admins). Resolving stamps `closedAt`. */
export const setStatus = mutation
    .input({ id: v.id("incidents"), organizationId: v.id("organizations"), status: incidentStatus })
    .mutation(async ({ ctx: context, args: { id, organizationId, status } }): Promise<Id<"incidents">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "incident");

        const now = Date.now();

        await context.db.patch(id, status === "resolved" ? { closedAt: now, status, updatedAt: now } : { closedAt: undefined, status, updatedAt: now });

        return id;
    });
