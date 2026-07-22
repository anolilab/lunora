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

/** Every rule target — count-crossing (`issue`/`incident`/`uptime`) + metric-window. */
type RuleTarget = "error_rate" | "incident" | "issue" | "latency_p95" | "llm_cost" | "uptime";

/** Metric-window targets, which additionally require `windowMinutes` (+ optional comparator/scope). */
const METRIC_TARGETS = new Set<RuleTarget>(["error_rate", "latency_p95", "llm_cost"]);

interface AlertRuleRow {
    _id: Id<"alertRules">;
    channel: "email" | "pagerduty" | "slack" | "webhook";
    comparator?: "gt" | "lt";
    createdAt: number;
    destination: string;
    enabled: boolean;
    functionPath?: string;
    name: string;
    organizationId: Id<"organizations">;
    target: RuleTarget;
    threshold: number;
    windowMinutes?: number;
}

interface AlertRow {
    _id: Id<"alerts">;
    channel: "email" | "pagerduty" | "slack" | "webhook";
    createdAt: number;
    deliveredAt?: number;
    destination: string;
    status: "delivered" | "failed" | "firing";
    subject: string;
    target: RuleTarget;
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
        channel: v.union(v.literal("email"), v.literal("webhook"), v.literal("slack"), v.literal("pagerduty")),
        // Metric targets only: how the window value is compared to `threshold`. Default `gt`.
        comparator: v.optional(v.union(v.literal("gt"), v.literal("lt"))),
        destination: v.string(),
        // Metric targets only: optional function-path scope for the window.
        functionPath: v.optional(v.string()),
        name: v.string(),
        organizationId: v.id("organizations"),
        target: v.union(
            v.literal("issue"),
            v.literal("incident"),
            v.literal("uptime"),
            v.literal("error_rate"),
            v.literal("latency_p95"),
            v.literal("llm_cost"),
        ),
        threshold: v.number(),
        // Metric targets only: rolling window length in minutes (required for them).
        windowMinutes: v.optional(v.number()),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"alertRules">> => {
        await assertMember(context, args.organizationId, ["owner", "admin"]);

        const isMetric = METRIC_TARGETS.has(args.target);

        // Count-crossing thresholds are event counts (≥ 1); metric thresholds are
        // percentages / ms / cost budgets and may legitimately be fractional (≥ 0).
        if (isMetric ? args.threshold < 0 : args.threshold < 1) {
            throw new LunoraError("BAD_REQUEST", isMetric ? "threshold must be at least 0" : "threshold must be at least 1");
        }

        if (isMetric && (args.windowMinutes === undefined || args.windowMinutes < 1)) {
            throw new LunoraError("BAD_REQUEST", "windowMinutes must be at least 1 for a metric rule");
        }

        // SSRF guard: the edge `fetch`es a `webhook`/`slack` destination when the
        // alert fires, so both must be an https URL to a public host. `pagerduty`'s
        // destination is an integration (routing) key posted to PagerDuty's own
        // fixed endpoint — it just has to be non-empty.
        if ((args.channel === "webhook" || args.channel === "slack") && !isSafeWebhookUrl(args.destination)) {
            throw new LunoraError("BAD_REQUEST", `${args.channel} destination must be an https:// URL to a public host`);
        }

        if (args.channel === "pagerduty" && args.destination.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "pagerduty destination must be an integration (routing) key");
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
            // Only persist the metric-only fields for metric rules, so a count
            // rule stays exactly as before (no stray comparator/window columns).
            ...(isMetric
                ? { comparator: args.comparator ?? "gt", windowMinutes: args.windowMinutes, ...(args.functionPath ? { functionPath: args.functionPath } : {}) }
                : {}),
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
