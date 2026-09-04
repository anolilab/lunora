import { LunoraError } from "@lunora/server";

import type { AlertFamily, AlertTarget, DeployAlertSource } from "../src/telemetry/alerts";
import { alertFamily, fireDeployRules, isSafeWebhookUrl } from "../src/telemetry/alerts";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Alert rules + fired alerts — the Cloud Observability "watches while you sleep"
 * tier. Rules are configured from the dashboard (owners/admins) and evaluated
 * inside the telemetry ingest (`lunora/telemetry.ts`), which inserts a `firing`
 * alert row when a rule's threshold is first crossed. The router edge delivers
 * it (email/webhook) and calls {@link markDelivered}. These functions back the
 * hosted `AlertsSection`; reads are members-only.
 */

/** Every rule target, from the one place the taxonomy is declared (`src/telemetry/alerts.ts`). */
type RuleTarget = AlertTarget;

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

        return page.toSorted((a, b) => b.createdAt - a.createdAt);
    });

/**
 * Validate a new rule's numeric shape, split out of {@link createRule} so the
 * mutation body stays about authorization + persistence.
 *
 * The rules differ by target family: count-crossing thresholds are event counts
 * (≥ 1), while metric thresholds are percentages / ms / cost budgets that may
 * legitimately be fractional (≥ 0) — and in `deviation` mode a percent change,
 * where a NEGATIVE threshold is the meaningful way to say "fell below normal",
 * so that mode is deliberately not floor-checked.
 */
const assertRuleShape = (
    args: { baselineWindows?: number; mode?: "deviation" | "threshold"; threshold: number; windowMinutes?: number },
    family: AlertFamily,
): void => {
    const isMetric = family === "metric";

    if (args.mode === "deviation" && !isMetric) {
        throw new LunoraError("BAD_REQUEST", "deviation mode applies to metric targets only");
    }

    // An event rule has nothing numeric to validate — it has no quantity at all —
    // so the caller's `threshold` is ignored rather than rejected, and `createRule`
    // stores 0 rather than whatever arrived. A dashboard form that always sends the
    // field does not have to know which targets read it, and no reader inherits a
    // number nothing checked.
    if (family === "event") {
        return;
    }

    if (args.mode !== "deviation" && (isMetric ? args.threshold < 0 : args.threshold < 1)) {
        throw new LunoraError("BAD_REQUEST", isMetric ? "threshold must be at least 0" : "threshold must be at least 1");
    }

    if (isMetric && (args.windowMinutes === undefined || args.windowMinutes < 1)) {
        throw new LunoraError("BAD_REQUEST", "windowMinutes must be at least 1 for a metric rule");
    }

    if (args.baselineWindows !== undefined && args.baselineWindows < 1) {
        throw new LunoraError("BAD_REQUEST", "baselineWindows must be at least 1");
    }
};

/** Create an alert rule (owners/admins). New rules start enabled. */
export const createRule = mutation
    .use(rateLimit("api"))
    .input({
        // Metric `deviation` rules only: windows of history averaged into the
        // trailing baseline. Default 7.
        baselineWindows: v.optional(v.number()),
        channel: v.union(v.literal("email"), v.literal("webhook"), v.literal("slack"), v.literal("pagerduty")),
        // Metric targets only: how the window value is compared to `threshold`. Default `gt`.
        comparator: v.optional(v.union(v.literal("gt"), v.literal("lt"))),
        destination: boundedString(LIMITS.url),
        // Metric targets only: optional function-path scope for the window.
        functionPath: v.optional(boundedString(LIMITS.token)),
        // Metric targets only: compare the window value to `threshold` directly
        // (`threshold`, the default), or to its trailing baseline with
        // `threshold` read as a percent change (`deviation`).
        mode: v.optional(v.union(v.literal("threshold"), v.literal("deviation"))),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        target: v.union(
            v.literal("issue"),
            v.literal("incident"),
            v.literal("uptime"),
            v.literal("error_rate"),
            v.literal("latency_p95"),
            v.literal("llm_cost"),
            v.literal("deploy"),
        ),
        threshold: v.number(),
        // Metric targets only: rolling window length in minutes (required for them).
        windowMinutes: v.optional(v.number()),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"alertRules">> => {
        await assertMember(context, args.organizationId, ["owner", "admin"]);

        const family = alertFamily(args.target);
        const isMetric = family === "metric";

        assertRuleShape(args, family);

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

        const { now } = context;

        return context.db.insert("alertRules", {
            channel: args.channel,
            createdAt: now,
            destination: args.destination,
            enabled: true,
            name: args.name,
            organizationId: args.organizationId,
            target: args.target,
            // An event rule's threshold is never read, and storing an unvalidated
            // one (a `NaN`, a negative) leaves a number in the row that a future
            // reader could mistake for meaningful.
            threshold: family === "event" ? 0 : args.threshold,
            updatedAt: now,
            // Only persist the metric-only fields for metric rules, so a count
            // rule stays exactly as before (no stray comparator/window columns).
            ...(isMetric
                ? {
                      comparator: args.comparator ?? "gt",
                      windowMinutes: args.windowMinutes,
                      ...(args.functionPath ? { functionPath: args.functionPath } : {}),
                      ...(args.mode ? { mode: args.mode } : {}),
                      ...(args.baselineWindows === undefined ? {} : { baselineWindows: args.baselineWindows }),
                  }
                : {}),
        });
    });

/** Enable or disable a rule (owners/admins). */
export const setRuleEnabled = mutation
    .use(rateLimit("api"))
    .input({ enabled: v.boolean(), id: v.id("alertRules"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { enabled, id, organizationId } }): Promise<Id<"alertRules">> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, id, organizationId, "alert rule");
        await context.db.patch(id, { enabled, updatedAt: context.now });

        return id;
    });

/** Delete a rule (owners/admins). Past fired alerts are retained. */
export const deleteRule = mutation
    .use(rateLimit("api"))
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

    return page.toSorted((a, b) => b.createdAt - a.createdAt);
});

/**
 * Stamp fired alerts delivered after the edge sent them (deploy-key authorized —
 * same credential as the ingest that created them). Each id is org-checked to
 * close the cross-org IDOR on a shared-key call.
 */
export const markDelivered = mutation
    .use(rateLimit("machine"))
    .input({
        deployKey: boundedString(LIMITS.token),
        ids: v.array(v.id("alerts")),
        organizationId: v.id("organizations"),
    })
    .mutation(async ({ ctx: context, args: { deployKey, ids, organizationId } }): Promise<{ delivered: number }> => {
        await authorizeDeployKey(context, organizationId, deployKey, "org-wide");

        const { now } = context;

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- small bounded set; the global mutation is serialized
            await assertRowInOrg(context, id, organizationId, "alert");
            // eslint-disable-next-line no-await-in-loop -- see above
            await context.db.patch(id, { deliveredAt: now, status: "delivered", updatedAt: now });
        }

        return { delivered: ids.length };
    });

/**
 * Fire the org's `deploy` rules for one release-path failure — insert an `alerts`
 * row per enabled rule and return how many were raised.
 *
 * A plain exported helper rather than a mutation of its own, because every caller
 * is already inside a mutation that has just written the failure it is reporting:
 * `builds.fail`, `deployments.updateStatus`, and the rollout guard. Firing in the
 * same transaction is what makes "the build is marked failed" and "somebody was
 * told" one outcome instead of two that can disagree.
 *
 * It deliberately does NOT deliver. Delivery needs `fetch`, which a mutation does
 * not have, so the row is left `firing` and the every-minute drain sweep
 * (`src/telemetry/alert-drain.ts`) sends it. That indirection is also what makes
 * an alert survive the edge dying mid-send, which the fire-and-deliver-inline
 * paths do not.
 *
 * `hash` carries the failing thing's id, so a re-fire for the same release is
 * identifiable in the alert list rather than looking like an unrelated second
 * failure.
 */
export const fireDeployAlerts = async (
    context: MutationContext,
    organizationId: Id<"organizations">,
    hash: string,
    source: DeployAlertSource,
): Promise<number> => {
    const { page } = await context.db.alertRules.findMany({ where: { organizationId, target: "deploy" } });
    const enabled = page.filter((rule) => rule.enabled);

    return fireDeployRules(
        enabled.map((rule) => {
            return { channel: rule.channel, destination: rule.destination, name: rule.name, ruleId: rule._id };
        }),
        source,
        { hash, now: context.now, organizationId },
        async (row) => await context.db.insert("alerts", row),
    );
};
