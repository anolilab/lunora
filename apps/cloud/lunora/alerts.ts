import { LunoraError } from "@lunora/server";

import type { AlertFamily, AlertTarget, DeployAlertSource, EventRule, SpendAlertSource } from "../src/telemetry/alerts";
import { alertFamily, fireDeployRules, fireSpendRules, isSafeWebhookUrl } from "../src/telemetry/alerts";
import { MIN_ANOMALY_SAMPLES } from "../src/telemetry/anomaly";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { alertTarget, anomalyTarget } from "./tables/shared";
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
/** The largest anomaly threshold accepted, in standard deviations; past it a rule could never fire. */
const MAX_ANOMALY_THRESHOLD = 50;

/**
 * An anomaly rule thresholds a z-score, so its threshold is a signed number of
 * standard deviations: at least 1 sigma above (`gt`) or below (`lt`) normal. A
 * smaller magnitude fires on ordinary noise; a `gt` rule with a negative
 * threshold fires on every hour that is not a collapse.
 */
const assertAnomalyThreshold = (args: { comparator?: "gt" | "lt"; mode?: "deviation" | "threshold"; threshold: number }): void => {
    if (args.mode !== undefined) {
        throw new LunoraError("BAD_REQUEST", "mode applies to metric targets only");
    }

    const magnitude = args.comparator === "lt" ? -args.threshold : args.threshold;

    if (!Number.isFinite(magnitude) || magnitude < 1 || magnitude > MAX_ANOMALY_THRESHOLD) {
        throw new LunoraError(
            "BAD_REQUEST",
            `an anomaly threshold is a number of standard deviations: 1 to ${String(MAX_ANOMALY_THRESHOLD)} with "gt", -1 to -${String(MAX_ANOMALY_THRESHOLD)} with "lt"`,
        );
    }
};

const assertRuleShape = (
    args: { baselineWindows?: number; comparator?: "gt" | "lt"; mode?: "deviation" | "threshold"; threshold: number; windowMinutes?: number },
    family: AlertFamily,
): void => {
    const isMetric = family === "metric";

    if (family === "anomaly") {
        assertAnomalyThreshold(args);

        return;
    }

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
        // Metric and anomaly targets: how the window value (or score) is compared to `threshold`. Default `gt`.
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
        target: alertTarget,
        threshold: v.number(),
        // Metric targets only: rolling window length in minutes (required for them).
        windowMinutes: v.optional(v.number()),
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"alertRules">> => {
        const { organizationId } = await assertMember(context, args.organizationId, ["owner", "admin"]);

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
            organizationId,
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
            // An anomaly rule's comparator says which way the score must move.
            ...(family === "anomaly" ? { comparator: args.comparator ?? "gt" } : {}),
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

/** The org's enabled rules on one event target, shaped for the firing helpers. */
const enabledEventRules = async (context: MutationContext, organizationId: Id<"organizations">, target: "deploy" | "spend"): Promise<EventRule[]> => {
    const { page } = await context.db.alertRules.findMany({ where: { organizationId, target } });

    return page
        .filter((rule) => rule.enabled)
        .map((rule) => {
            return { channel: rule.channel, destination: rule.destination, name: rule.name, ruleId: rule._id };
        });
};

/** Silences an org may hold at once (pending or active). Ended ones are pruned on create. */
const MAX_SILENCES_PER_ORG = 20;

/** The longest one silence may run — long enough for a load-test week, short enough to never become "off". */
const MAX_SILENCE_MS = 30 * 24 * 60 * 60 * 1000;

interface AnomalySilenceRow {
    _id: Id<"anomalySilences">;
    createdAt: number;
    createdBy: string;
    endsAt: number;
    reason: string;
    startsAt: number;
    target: "error_anomaly" | "usage_anomaly";
}

/** An org's silences that have not ended yet, soonest-ending first (any member). */
export const silences = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<AnomalySilenceRow[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.anomalySilences.findMany({ where: { endsAt: { gt: context.now }, organizationId } });

        return page.toSorted((a, b) => a.endsAt - b.endsAt);
    });

/**
 * Silence an anomaly target for a window (owners/admins). While a silence overlaps
 * an hour, the anomaly sweep skips that hour of the target's signal entirely — no
 * score and no baseline update — instead of firing and hiding the alert.
 *
 * Bounded in count and length so a silence is a planned pause, never a way to
 * leave detection off: at most {@link MAX_SILENCES_PER_ORG} pending or active, each
 * at most {@link MAX_SILENCE_MS} long and starting within that horizon.
 */
export const createSilence = mutation
    .use(rateLimit("api"))
    .input({
        endsAt: v.number(),
        organizationId: v.id("organizations"),
        reason: boundedString(LIMITS.name),
        // Absent ⇒ now.
        startsAt: v.optional(v.number()),
        target: anomalyTarget,
    })
    .mutation(async ({ ctx: context, args }): Promise<Id<"anomalySilences">> => {
        const member = await assertMember(context, args.organizationId, ["owner", "admin"]);
        const { now } = context;
        const startsAt = args.startsAt ?? now;

        if (!Number.isFinite(startsAt) || !Number.isFinite(args.endsAt) || args.endsAt <= startsAt || args.endsAt <= now) {
            throw new LunoraError("BAD_REQUEST", "a silence must end after it starts, and in the future");
        }

        if (args.endsAt - startsAt > MAX_SILENCE_MS || startsAt > now + MAX_SILENCE_MS) {
            throw new LunoraError("BAD_REQUEST", "a silence may last at most 30 days and start within the next 30 days");
        }

        if (args.reason.trim() === "") {
            throw new LunoraError("BAD_REQUEST", "a silence needs a reason, so the next person knows why detection was off");
        }

        const { page } = await context.db.anomalySilences.findMany({ where: { organizationId: member.organizationId } });

        // Ended silences have no effect left; dropping them here keeps the table at
        // most MAX_SILENCES_PER_ORG rows per org without a prune cron.
        for (const ended of page.filter((row) => row.endsAt <= now)) {
            // eslint-disable-next-line no-await-in-loop -- at most MAX_SILENCES_PER_ORG rows
            await context.db.delete(ended._id);
        }

        if (page.filter((row) => row.endsAt > now).length >= MAX_SILENCES_PER_ORG) {
            throw new LunoraError("BAD_REQUEST", `an organization may hold at most ${String(MAX_SILENCES_PER_ORG)} silences; remove one first`);
        }

        const id = await context.db.insert("anomalySilences", {
            createdAt: now,
            createdBy: member.userId,
            endsAt: args.endsAt,
            organizationId: member.organizationId,
            reason: args.reason.trim(),
            startsAt,
            target: args.target,
        });

        // Turning detection off is exactly what an attacker with an admin seat would
        // do first, so it leaves the same trail as any other security change.
        await context.db.insert("auditLog", {
            action: "alerts.silence.create",
            actorUserId: member.userId,
            createdAt: now,
            organizationId: member.organizationId,
            target: `${args.target} until ${new Date(args.endsAt).toISOString()}`,
        });

        return id;
    });

/** Remove a silence (owners/admins); detection resumes from the next hour. */
export const deleteSilence = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("anomalySilences"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<Id<"anomalySilences">> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, id, organizationId, "silence");
        await context.db.delete(id);
        await context.db.insert("auditLog", {
            action: "alerts.silence.delete",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: id,
        });

        return id;
    });

/** One signal's baseline as the Alerts tab shows it. */
interface AnomalyBaselineView {
    lastBucketStart: number;
    lastMean: number;
    lastScore: number;
    lastValue: number;
    samples: number;
    signal: "errors" | "requests";
    /** `true` until the baseline has the day of history it needs to score. */
    warmingUp: boolean;
}

/** The org's anomaly baselines — the derived score the anomaly rules threshold (any member). */
export const anomalyBaselines = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<AnomalyBaselineView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.anomalyBaselines.findMany({ where: { organizationId } });

        return page.map((row) => {
            return {
                lastBucketStart: row.lastBucketStart,
                lastMean: row.lastMean,
                lastScore: row.lastScore,
                lastValue: row.lastValue,
                samples: row.samples,
                signal: row.signal,
                warmingUp: row.samples <= MIN_ANOMALY_SAMPLES,
            };
        });
    });

/**
 * Fire the org's `deploy` rules for one release-path failure — insert an `alerts`
 * row per enabled rule and return how many were raised.
 *
 * A plain exported helper rather than a mutation of its own, because every caller
 * is already inside a mutation that has just written the failure it is reporting:
 * `builds.fail` and `deployments.updateStatus`. Firing in the
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
): Promise<number> =>
    fireDeployRules(await enabledEventRules(context, organizationId, "deploy"), source, { hash, now: context.now, organizationId }, async (row) =>
        context.db.insert("alerts", row),
    );

/**
 * Fire the org's `spend` rules for a soft-cap warning or a hard-cap suspension
 * (plan 365 W2), in the enforcement sweep's own transaction — the latch it
 * stamps and the alert rows it raises are one outcome. Delivered by the drain
 * sweep, like `deploy`. `hash` names the period and level, so a re-fire for the
 * same period is identifiable in the alert list.
 */
export const fireSpendAlerts = async (
    context: MutationContext,
    organizationId: Id<"organizations">,
    periodStart: number,
    source: SpendAlertSource,
): Promise<number> =>
    fireSpendRules(
        await enabledEventRules(context, organizationId, "spend"),
        source,
        { hash: `spend:${source.level}:${String(periodStart)}`, now: context.now, organizationId },
        async (row) => context.db.insert("alerts", row),
    );
