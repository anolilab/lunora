import { evaluateSpendCap } from "../src/billing/spend";
import { aggregateUsage } from "../src/billing/usage";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, authorizeDeployKey } from "./authz";

/**
 * Platform resource metering (CLOUD-PLAN.md §4). `record` is written by the
 * metering ingestion endpoint (`POST /v1/usage`) and the Analytics-Engine
 * stream; `summary` rolls a period up for the dashboard/billing. The roll-up
 * logic is the pure `aggregateUsage`. (Distinct from `@lunora/payment`'s usage
 * ledger, which meters billing features via `ctx.payments`.)
 */

const kind = v.union(v.literal("requests"), v.literal("cpuMs"), v.literal("storageBytes"));

/** Record a metered event. SYSTEM only (internalMutation — cron/metering writer). */
export const record = internalMutation
    .input({
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"platformUsage">> =>
        context.db.insert("platformUsage", {
            createdAt: Date.now(),
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        }),
    );

/**
 * Ingest a metered event from the platform data plane (`POST /v1/usage`).
 * Public, but deploy-key authenticated: a valid, unrevoked key for the org is
 * the credential (no user session on the metering path, same as the deploy
 * path). The tenant Worker / metering sidecar reports requests/CPU/storage here.
 */
export const ingest = mutation
    .input({
        deployKey: v.string(),
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"platformUsage">> => {
        await authorizeDeployKey(context, arguments_.organizationId, arguments_.deployKey);

        return context.db.insert("platformUsage", {
            createdAt: Date.now(),
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        });
    });

interface PlatformUsageRow {
    _id: Id<"platformUsage">;
    createdAt: number;
    kind: "cpuMs" | "requests" | "storageBytes";
    organizationId: Id<"organizations">;
    periodStart: number;
    quantity: number;
}

/** Epoch ms for the first instant of the current UTC month. */
const currentPeriodStart = (): number => {
    const now = new Date();

    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
};

/**
 * Compact closed-period metering events (CLOUD-PLAN.md §4). Per
 * (org, period, kind), collapse many raw rows from a *past* period into a single
 * summed row — bounding row growth while leaving `summary` (which sums) exact.
 * The current period is left untouched so live writes never race the compaction.
 * SYSTEM only (cron dispatch).
 *
 * The D1/global backend has no multi-statement transaction, so the write order
 * is chosen to fail safe: **delete the extra rows first, then set the survivor's
 * total last**. A crash mid-compaction can only *under*-count (some rows gone
 * before the survivor is updated) — it can never leave the summed row alongside
 * surviving originals, which would *double-count* (over-bill). The survivor is
 * patched (not insert-then-delete) so no orphan summed row can ever exist.
 */
export const rollup = internalMutation.mutation(async ({ ctx: context }): Promise<{ compacted: number }> => {
    const cutoff = currentPeriodStart();
    const { page } = await context.db.platformUsage.findMany({});
    const closed = (page as unknown as PlatformUsageRow[]).filter((row) => row.periodStart < cutoff);

    const groups = new Map<string, PlatformUsageRow[]>();

    for (const row of closed) {
        const groupKey = `${row.organizationId}|${String(row.periodStart)}|${row.kind}`;
        const group = groups.get(groupKey) ?? [];

        group.push(row);
        groups.set(groupKey, group);
    }

    let compacted = 0;

    for (const rows of groups.values()) {
        if (rows.length < 2) {
            continue;
        }

        const [survivor, ...extras] = rows;
        const total = rows.reduce((sum, row) => sum + row.quantity, 0);

        // Delete the extras first (fail-safe ordering — see the doc comment).
        for (const row of extras) {
            // eslint-disable-next-line no-await-in-loop -- sequential delete of the now-summed rows
            await context.db.delete(row._id);
        }

        // Then fold the group total onto the surviving row.
        // eslint-disable-next-line no-await-in-loop -- one patch per group; volumes are small
        await context.db.patch(survivor._id, { quantity: total });

        compacted += extras.length;
    }

    return { compacted };
});

/** Summed usage for an org over a billing period (members only). */
export const summary = query
    .input({ organizationId: v.id("organizations"), periodStart: v.number() })
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<Record<"cpuMs" | "requests" | "storageBytes", number>> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.platformUsage.findMany({ where: { organizationId } });

        return aggregateUsage(page, periodStart);
    });

/**
 * Enforce aggregate spend caps (GAPS.md C1). Estimates each org's current-
 * period spend from the metered platform usage and suspends orgs over their
 * cap (plan default or org override) — the dispatcher serves 503 for a
 * suspended org's tenants. Self-healing: orgs back under the cap (new period,
 * raised cap, upgraded plan) are unsuspended on the next run. SYSTEM only
 * (cron dispatch).
 */
export const enforceSpendCaps = internalMutation.mutation(async ({ ctx: context }): Promise<{ suspended: number; unsuspended: number }> => {
    const periodStart = currentPeriodStart();
    const { page: usageRows } = await context.db.platformUsage.findMany({});
    const byOrg = new Map<string, { cpuMs: number; requests: number }>();

    for (const row of usageRows as unknown as PlatformUsageRow[]) {
        if (row.periodStart < periodStart || (row.kind !== "requests" && row.kind !== "cpuMs")) {
            continue;
        }

        const bucket = byOrg.get(row.organizationId) ?? { cpuMs: 0, requests: 0 };

        bucket[row.kind] += row.quantity;
        byOrg.set(row.organizationId, bucket);
    }

    const { page: organizationPage } = await context.db.organizations.findMany({});
    const organizations = organizationPage as unknown as {
        _id: string;
        plan: string;
        spendCapMinor?: number;
        suspendedAt?: number;
        suspendedReason?: string;
    }[];

    let suspended = 0;
    let unsuspended = 0;

    for (const organization of organizations) {
        const usage = byOrg.get(organization._id) ?? { cpuMs: 0, requests: 0 };
        const decision = evaluateSpendCap({ capMinorOverride: organization.spendCapMinor, plan: organization.plan, usage });

        if (decision.suspend && organization.suspendedAt === undefined) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organization._id as Id<"organizations">, { suspendedAt: Date.now(), suspendedReason: "spend-cap" });
            // eslint-disable-next-line no-await-in-loop -- one audit row per transition
            await context.db.insert("auditLog", {
                action: "organization.suspend",
                actorUserId: "system:spend-cap",
                createdAt: Date.now(),
                organizationId: organization._id,
                target: `spend ${String(decision.spendMinor)} >= cap ${String(decision.capMinor)}`,
            });
            suspended += 1;
        } else if (!decision.suspend && organization.suspendedAt !== undefined && organization.suspendedReason === "spend-cap") {
            // Only lift our own suspensions — dunning/support ones stay (GAPS.md C2).
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organization._id as Id<"organizations">, { suspendedAt: undefined, suspendedReason: undefined });
            unsuspended += 1;
        }
    }

    return { suspended, unsuspended };
});

interface OverageDebitRow {
    _id: Id<"overageDebits">;
    debitedCredits: number;
    organizationId: Id<"organizations">;
    periodStart: number;
}

/**
 * The overage-debit watermark for (org, period) — how many prepaid credits
 * previous reconciliation runs already debited (GAPS.md C3 follow-up).
 * SYSTEM only (reconciliation dispatch).
 */
export const overageWatermark = internalQuery
    .input({ organizationId: v.id("organizations"), periodStart: v.number() })
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<{ debitedCredits: number }> => {
        const { page } = await context.db.overageDebits.findMany({ where: { organizationId, periodStart } });
        const row = (page as unknown as OverageDebitRow[])[0];

        return { debitedCredits: row?.debitedCredits ?? 0 };
    });

/**
 * Advance the overage-debit watermark after a successful Creem debit. The
 * watermark only moves forward — a stale writer can never roll it back and
 * cause a double charge. SYSTEM only (reconciliation dispatch).
 */
export const recordOverageDebit = internalMutation
    .input({ debitedCredits: v.number(), organizationId: v.id("organizations"), periodStart: v.number() })
    .mutation(async ({ ctx: context, args: { debitedCredits, organizationId, periodStart } }): Promise<void> => {
        const { page } = await context.db.overageDebits.findMany({ where: { organizationId, periodStart } });
        const row = (page as unknown as OverageDebitRow[])[0];
        const now = Date.now();

        if (!row) {
            await context.db.insert("overageDebits", { debitedCredits, organizationId, periodStart, updatedAt: now });

            return;
        }

        if (debitedCredits > row.debitedCredits) {
            await context.db.patch(row._id, { debitedCredits, updatedAt: now });
        }
    });

/**
 * Daily usage series for the period (members) — feeds the studio's usage
 * chart (GAPS.md ring 3). Buckets raw `platformUsage` events by UTC day of
 * their `createdAt`; compacted history keeps period totals correct, so the
 * series is best-effort recent detail, not an invoice.
 */
export const series = query
    .input({ organizationId: v.id("organizations"), periodStart: v.number() })
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<{ cpuMs: number; day: number; requests: number }[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.platformUsage.findMany({ where: { organizationId } });
        const dayMs = 24 * 60 * 60 * 1000;
        const buckets = new Map<number, { cpuMs: number; requests: number }>();

        for (const row of page as unknown as PlatformUsageRow[]) {
            if (row.periodStart !== periodStart || (row.kind !== "requests" && row.kind !== "cpuMs")) {
                continue;
            }

            const day = Math.floor(row.createdAt / dayMs) * dayMs;
            const bucket = buckets.get(day) ?? { cpuMs: 0, requests: 0 };

            bucket[row.kind] += row.quantity;
            buckets.set(day, bucket);
        }

        return [...buckets.entries()]
            .map(([day, bucket]) => {
                return { day, ...bucket };
            })
            .toSorted((a, b) => a.day - b.day);
    });
