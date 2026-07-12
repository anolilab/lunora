import { LunoraError } from "@lunora/server";

import { isSafeWebhookUrl } from "../src/telemetry/alerts";
import type { Id } from "./_generated/dataModel.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";

/**
 * Alert rules + fired alerts — the Cloud Observability "watches while you sleep"
 * tier. Rules are configured from the dashboard (owners/admins) and evaluated
 * inside the telemetry ingest (`lunora/telemetry.ts`), which inserts a `firing`
 * alert row when a rule's threshold is first crossed. The router edge delivers
 * it (email/webhook) and calls {@link markDelivered}. These functions back the
 * hosted `AlertsSection`; reads are members-only.
 */

interface AlertRuleRow {
    _id: Id<"alertRules">;
    channel: "email" | "webhook";
    createdAt: number;
    destination: string;
    enabled: boolean;
    name: string;
    organizationId: Id<"organizations">;
    target: "incident" | "issue";
    threshold: number;
}

interface AlertRow {
    _id: Id<"alerts">;
    channel: "email" | "webhook";
    createdAt: number;
    deliveredAt?: number;
    destination: string;
    status: "delivered" | "failed" | "firing";
    subject: string;
    target: "incident" | "issue";
}

/** An org's alert rules, most-recent first (any member). */
export const rules = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<AlertRuleRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.alertRules.findMany({ where: { organizationId } });

        return (page as unknown as AlertRuleRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
    });

/** Create an alert rule (owners/admins). New rules start enabled. */
export const createRule = mutation
    .input({
        channel: v.union(v.literal("email"), v.literal("webhook")),
        destination: v.string(),
        name: v.string(),
        organizationId: v.id("organizations"),
        target: v.union(v.literal("issue"), v.literal("incident")),
        threshold: v.number(),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"alertRules">> => {
        await assertMember(context, args.organizationId, ["owner", "admin"]);

        if (args.threshold < 1) {
            throw new LunoraError("BAD_REQUEST", "threshold must be at least 1");
        }

        // SSRF guard: the edge `fetch`es a webhook destination when the alert fires.
        if (args.channel === "webhook" && !isSafeWebhookUrl(args.destination)) {
            throw new LunoraError("BAD_REQUEST", "webhook destination must be an https:// URL to a public host");
        }

        const now = Date.now();

        return context.db.insert("alertRules", {
            channel: args.channel,
            createdAt: now,
            destination: args.destination,
            enabled: true,
            name: args.name,
            organizationId: args.organizationId,
            target: args.target,
            threshold: args.threshold,
            updatedAt: now,
        });
    });

/** Enable or disable a rule (owners/admins). */
export const setRuleEnabled = mutation
    .input({ enabled: v.boolean(), id: v.id("alertRules"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { enabled, id, organizationId } }): Promise<Id<"alertRules">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "alert rule");
        await context.db.patch(id, { enabled, updatedAt: Date.now() });

        return id;
    });

/** Delete a rule (owners/admins). Past fired alerts are retained. */
export const deleteRule = mutation
    .input({ id: v.id("alertRules"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<Id<"alertRules">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "alert rule");
        await context.db.delete(id);

        return id;
    });

/** An org's fired alerts, most-recent first (any member). */
export const list = query.input({ organizationId: v.id("organizations") }).query(async ({ ctx: context, args: { organizationId } }): Promise<AlertRow[]> => {
    await assertMember(context, organizationId);

    const { page } = await context.db.alerts.findMany({ where: { organizationId } });

    return (page as unknown as AlertRow[]).toSorted((a, b) => b.createdAt - a.createdAt);
});

/**
 * Stamp fired alerts delivered after the edge sent them (deploy-key authorized —
 * same credential as the ingest that created them). Each id is org-checked to
 * close the cross-org IDOR on a shared-key call.
 */
export const markDelivered = mutation
    .input({ deployKey: v.string(), ids: v.array(v.id("alerts")), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { deployKey, ids, organizationId } }): Promise<{ delivered: number }> => {
        await authorizeDeployKey(context, organizationId, deployKey);

        const now = Date.now();

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- small bounded set; the global mutation is serialized
            await assertRowInOrg(context, id, organizationId, "alert");
            // eslint-disable-next-line no-await-in-loop -- see above
            await context.db.patch(id, { deliveredAt: now, status: "delivered", updatedAt: now });
        }

        return { delivered: ids.length };
    });
