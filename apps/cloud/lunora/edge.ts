import { LunoraError } from "@lunora/server";

import type { FirewallEvent, OrganizationHostnames } from "../src/edge/protection";
import { edgeBudget, MAX_FIREWALL_WINDOW_MS, organizationHostnames, RATE_LIMIT_PERIODS, RATE_LIMIT_REQUESTS } from "../src/edge/protection";
import type { TargetEnvironment } from "../src/targets/registry";
import { registeredFleet } from "../src/targets/registry";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext } from "./_generated/server.js";
import { action, internalMutation, mutation, query, v } from "./_generated/server.js";
import { assertMember } from "./authz";
import { rateLimit } from "./guards";
import { boundedString, LIMITS } from "./validators";

/**
 * Edge protection (plan 365 W7, D9): what Cloudflare's edge did to an
 * organization's traffic, and the two settings the organization controls there.
 *
 * Every tenant is behind Cloudflare's always-on L3/L4/L7 DDoS protection by
 * construction; this surfaces it and lets an owner tune it. Nothing here calls
 * Cloudflare except the firewall-events read: the settings record intent on the
 * org's `edgeRules` row, and the reconciler (`src/cloudflare/edge-rules.ts`)
 * applies it within a minute, idempotently, audit-logged and reversible.
 *
 * Only `cloudflare-wfp` projects are served from the platform zone. A project on
 * a customer box (`celld-vps`) or the customer's own Cloudflare account
 * (`cloudflare-workers`) has no firewall events here and no edge rule covers
 * it; every read names those projects rather than leaving them out silently.
 */

/** The `ctx.env` keys read here (`lunora/env.ts`); the fleet reads `CLOUDFLARE_API_TOKEN` and `LUNORA_SAAS_ZONE_ID` itself. */
type EdgeEnv = TargetEnvironment & {
    LUNORA_DDOS_OVERRIDE_BUDGET?: string;
    LUNORA_RATE_LIMIT_RULE_BUDGET?: string;
};

/** One edge rule as the studio sees it. */
interface EdgeRuleView {
    applied: boolean;
    armed?: boolean;
    engaged?: boolean;
    hostnames: string[];
    kind: "ddos_l7" | "rate_limit";
    lastError?: string;
    periodSeconds?: 10 | 60;
    requestsPerPeriod?: number;
    sensitivity?: "default" | "low" | "medium";
    status: "applied" | "failed" | "pending" | "removed" | "unavailable";
    updatedAt: number;
}

/** The org's edge rules (any member). Ids and Cloudflare rule ids stay server-side. */
export const rules = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<EdgeRuleView[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.edgeRules.findMany({ where: { organizationId } });

        return page.map((row) => {
            return {
                applied: row.applied,
                hostnames: row.targets.map((target) => target.hostname),
                kind: row.kind,
                status: row.status,
                updatedAt: row.updatedAt,
                ...(row.armed == null ? {} : { armed: row.armed }),
                ...(row.engaged == null ? {} : { engaged: row.engaged }),
                ...(row.lastError == null ? {} : { lastError: row.lastError }),
                ...(row.periodSeconds == null ? {} : { periodSeconds: row.periodSeconds }),
                ...(row.requestsPerPeriod == null ? {} : { requestsPerPeriod: row.requestsPerPeriod }),
                ...(row.sensitivity == null ? {} : { sensitivity: row.sensitivity }),
            };
        });
    });

/**
 * The erasure purge's half of an organization's edge rules
 * (`organizations.purgeDeleted`): delete the rows whose rule is NOT on the edge,
 * and leave the applied ones. Deleting an applied row would leave a rule on the
 * zone that no row names — still covering hostnames another organization can
 * claim next. The reconciler takes those off (an erased organization's removal
 * is retried without a cap) and deletes each row once its rule is gone.
 */
export const releaseEdgeRules = async (context: MutationContext, organizationId: Id<"organizations">): Promise<void> => {
    const { page } = await context.db.edgeRules.findMany({ where: { organizationId } });

    for (const row of page.filter((candidate) => !candidate.applied)) {
        // eslint-disable-next-line no-await-in-loop -- at most one row per kind
        await context.db.edgeRules.delete(row._id);
    }
};

/**
 * Upsert the org's row of `kind` as pending intent and audit the change. The
 * org id is the verified membership's, never an argument's.
 */
const recordIntent = async (
    context: MutationContext,
    member: { organizationId: Id<"organizations">; userId: string },
    kind: "ddos_l7" | "rate_limit",
    fields: Record<string, unknown>,
    detail: string,
): Promise<void> => {
    const { now } = context;
    const { page } = await context.db.edgeRules.findMany({ where: { kind, organizationId: member.organizationId } });
    const existing = page[0];
    const intent = { ...fields, attempts: 0, status: "pending" as const, updatedAt: now };

    await (existing
        ? context.db.edgeRules.patch(existing._id, intent)
        : context.db.insert("edgeRules", { ...intent, applied: false, createdAt: now, kind, organizationId: member.organizationId, targets: [] }));
    await context.db.insert("auditLog", {
        action: `edge.${kind}.configure`,
        actorUserId: member.userId,
        createdAt: now,
        organizationId: member.organizationId,
        target: detail,
    });
};

/**
 * Set the HTTP DDoS sensitivity for the org's hostnames (owners/admins).
 * `default` removes the override. Turning protection off is not offered.
 */
export const setDdosSensitivity = mutation
    .use(rateLimit("sensitive"))
    .input({
        organizationId: v.id("organizations"),
        sensitivity: v.union(v.literal("default"), v.literal("medium"), v.literal("low")),
    })
    .mutation(async ({ ctx: context, args }): Promise<null> => {
        const member = await assertMember(context, args.organizationId, ["owner", "admin"]);

        await recordIntent(context, member, "ddos_l7", { sensitivity: args.sensitivity }, `sensitivity ${args.sensitivity}`);

        return null;
    });

/**
 * Arm or disarm the anomaly → rate-limit action (owners/admins). While armed,
 * a firing `usage_anomaly` rule installs a per-IP rate limit of
 * `requestsPerPeriod` per `periodSeconds` on the org's hostnames, and its
 * recovery removes it. Disarming removes any limit in place.
 */
export const setAnomalyRateLimit = mutation
    .use(rateLimit("sensitive"))
    .input({
        enabled: v.boolean(),
        organizationId: v.id("organizations"),
        periodSeconds: v.optional(v.union(v.literal(10), v.literal(60))),
        requestsPerPeriod: v.optional(v.number()),
    })
    .mutation(async ({ ctx: context, args }): Promise<null> => {
        const member = await assertMember(context, args.organizationId, ["owner", "admin"]);

        if (!args.enabled) {
            await recordIntent(context, member, "rate_limit", { armed: false }, "disarmed");

            return null;
        }

        const requests = args.requestsPerPeriod;
        const period = args.periodSeconds ?? RATE_LIMIT_PERIODS[1];

        if (requests === undefined || !Number.isInteger(requests) || requests < RATE_LIMIT_REQUESTS.min || requests > RATE_LIMIT_REQUESTS.max) {
            throw new LunoraError(
                "BAD_REQUEST",
                `requestsPerPeriod must be a whole number from ${String(RATE_LIMIT_REQUESTS.min)} to ${String(RATE_LIMIT_REQUESTS.max)}`,
            );
        }

        await recordIntent(
            context,
            member,
            "rate_limit",
            { armed: true, periodSeconds: period, requestsPerPeriod: requests },
            `${String(requests)} per ${String(period)}s`,
        );

        return null;
    });

/** The org's recursion policy (any member). Absent on the row ⇒ `terminate`. */
export const recursionPolicy = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<"allow" | "terminate"> => {
        const member = await assertMember(context, organizationId);
        const organization = await context.db.organizations.get(member.organizationId);

        return organization?.recursionPolicy === "allow" ? "allow" : "terminate";
    });

/**
 * Set what the dispatcher does with a request chain that re-entered Lunora Cloud
 * past the depth cap (plan 365 W5, owners/admins): `terminate` (508, the
 * default) or `allow`, mirroring Lambda's recursion config. Audit-logged.
 */
export const setRecursionPolicy = mutation
    .use(rateLimit("sensitive"))
    .input({ organizationId: v.id("organizations"), policy: v.union(v.literal("terminate"), v.literal("allow")) })
    .mutation(async ({ ctx: context, args }): Promise<null> => {
        const member = await assertMember(context, args.organizationId, ["owner", "admin"]);

        await context.db.organizations.patch(member.organizationId, { recursionPolicy: args.policy });
        await context.db.insert("auditLog", {
            action: "recursion.policy",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: args.policy,
        });

        return null;
    });

/** One terminated-chain audit entry per script per this window, whatever the dispatcher sends. */
const RECURSION_AUDIT_WINDOW_MS = 60_000;

/**
 * Record that the dispatcher terminated a request chain (`POST /v1/tenants/recursion`,
 * admin-token gated). The organization is the one that owns the script's
 * deployment row — never a value the caller sends — and a script that is not
 * a deployment records nothing. Bounded: one entry per script per minute.
 */
export const recordRecursionStop = internalMutation
    .input({ depth: v.number(), scriptName: boundedString(LIMITS.name) })
    .mutation(async ({ ctx: context, args }): Promise<{ recorded: boolean }> => {
        const { page } = await context.db.deployments.findMany({ limit: 1, where: { scriptName: args.scriptName } });
        const deployment = page[0];

        if (!deployment) {
            return { recorded: false };
        }

        const depth = Number.isFinite(args.depth) ? Math.min(Math.max(Math.trunc(args.depth), 0), 9999) : 0;
        const target = `${args.scriptName} at depth ${String(depth)}`;
        const { page: recent } = await context.db.auditLog.findMany({
            limit: 1,
            orderBy: [{ createdAt: "desc" }],
            where: { action: "recursion.terminate", organizationId: deployment.organizationId, target },
        });

        if ((recent[0]?.createdAt ?? 0) > context.now - RECURSION_AUDIT_WINDOW_MS) {
            return { recorded: false };
        }

        await context.db.insert("auditLog", {
            action: "recursion.terminate",
            actorUserId: "system:dispatcher",
            createdAt: context.now,
            organizationId: deployment.organizationId,
            target,
        });

        return { recorded: true };
    });

/** The firewall view, from one read. */
interface FirewallView {
    /** Whether this cell lets an org hold each edge rule at all (the operator's budget is above zero). */
    capabilities: { ddosOverride: boolean; rateLimit: boolean };
    events: FirewallEvent[];
    /** How many of the org's hostnames the read covered. */
    hostnames: number;
    reason?: string;
    status: "ok" | "unavailable" | "unconfigured";
    /** Projects the platform zone does not serve, so nothing here covers them. */
    unsupported: OrganizationHostnames["unsupported"];
}

/**
 * The org's recent firewall events on the platform zone — what Cloudflare's WAF,
 * DDoS and rate-limit rules did to its traffic (members). An action: the read
 * is a `fetch` to the GraphQL Analytics API with the cell's token.
 *
 * Scoped by hostname, twice: the query filters to the org's own hostnames, and
 * the reader drops any row outside them. Degrades to `unconfigured` without a
 * zone or token and to `unavailable` with Cloudflare's reason when the token or
 * the zone's plan does not allow the read.
 */
export const firewall = action
    .use(rateLimit("archive"))
    .input({ from: v.optional(v.number()), organizationId: v.id("organizations"), to: v.optional(v.number()) })
    .action(async ({ ctx: context, args }): Promise<FirewallView> => {
        const { organizationId } = await assertMember(context, args.organizationId);
        const environment = (context.env ?? {}) as EdgeEnv;
        const [{ page: deployments }, { page: domains }, { page: projects }] = await Promise.all([
            context.db.deployments.findMany({ where: { organizationId, status: "live" } }),
            context.db.domains.findMany({ where: { organizationId } }),
            context.db.projects.findMany({ where: { organizationId } }),
        ]);
        const { hostnames, unsupported } = organizationHostnames({
            appDomain: environment.LUNORA_APP_DOMAIN ?? "lunora.app",
            deployments,
            domains,
            organizationId,
            projects,
        });
        const base = {
            capabilities: {
                ddosOverride: edgeBudget(environment.LUNORA_DDOS_OVERRIDE_BUDGET) > 0,
                rateLimit: edgeBudget(environment.LUNORA_RATE_LIMIT_RULE_BUDGET) > 0,
            },
            hostnames: hostnames.length,
            unsupported,
        };

        // Only `cloudflare-wfp`'s fleet fronts tenants with the platform edge.
        const edge = registeredFleet("cloudflare-wfp", environment)?.edge;

        if (edge === undefined) {
            return {
                ...base,
                events: [],
                reason: "firewall events are not configured on this cell (LUNORA_SAAS_ZONE_ID / CLOUDFLARE_API_TOKEN)",
                status: "unconfigured",
            };
        }

        const to = args.to ?? Date.now();
        const result = await edge.firewallEvents({ from: args.from ?? to - MAX_FIREWALL_WINDOW_MS, hostnames, to });

        return result.status === "ok"
            ? { ...base, events: result.events, status: "ok" }
            : { ...base, events: [], reason: result.reason, status: result.status };
    });
