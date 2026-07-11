import { generateText } from "@lunora/ai";
import { LunoraError } from "@lunora/server";

import { buildTriagePrompt } from "../src/telemetry/triage";
import type { Id } from "./_generated/dataModel.js";
import { action, mutation, query, v } from "./_generated/server.js";
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

/** A fast, capable Workers AI instruct model for incident triage. */
const TRIAGE_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

interface IncidentDocument {
    container?: string;
    count: number;
    hash: string;
    kind: "crash_loop" | "error_spike" | "oom";
    title: string;
}

interface RelatedIssue {
    count: number;
    culprit: string;
    sampleMessage: string;
    title: string;
}

/**
 * AI-triage an incident (any member): summarize the likely root cause and the
 * highest-impact next step from the incident and its related error groups, via
 * Workers AI (`@lunora/ai`). On-demand and ephemeral — the summary is returned
 * to the caller, not persisted. Billed per call, so it runs only when a member
 * explicitly asks (the dashboard "Triage" button).
 */
export const triage = action
    .input({ id: v.id("incidents"), organizationId: v.id("organizations") })
    .action(async ({ ctx: context, args: { id, organizationId } }): Promise<{ summary: string }> => {
        await assertMember(context, organizationId);
        await assertRowInOrg(context, id, organizationId, "incident");

        const incident = (await context.db.get(id)) as IncidentDocument | null;

        if (!incident) {
            throw new LunoraError("NOT_FOUND", "incident not found");
        }

        const { page } = await context.db.issues.findMany({ where: { hash: incident.hash, organizationId } });
        const issues = (page as unknown as RelatedIssue[]).map((issue) => {
            return {
                count: issue.count,
                culprit: issue.culprit,
                sampleMessage: issue.sampleMessage,
                title: issue.title,
            };
        });

        const { text } = await generateText({
            model: context.ai.model(TRIAGE_MODEL),
            prompt: buildTriagePrompt({ container: incident.container, count: incident.count, kind: incident.kind, title: incident.title }, issues),
        });

        return { summary: text };
    });
