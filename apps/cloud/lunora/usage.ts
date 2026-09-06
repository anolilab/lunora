import { LunoraError } from "@lunora/server";

import type { PeriodUsage, UsageMeter } from "../src/billing/spend";
import { estimatedSpendMinor, evaluateSpendCap, isUsageMeter } from "../src/billing/spend";
import type { UsageTotals } from "../src/billing/usage";
import { aggregateUsage } from "../src/billing/usage";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * Platform resource metering (CLOUD-PLAN.md §4). `record` is written by the
 * metering ingestion endpoint (`POST /v1/usage`) and the Analytics-Engine
 * stream; `summary` rolls a period up for the dashboard/billing. The roll-up
 * logic is the pure `aggregateUsage`. (Distinct from `@lunora/payment`'s usage
 * ledger, which meters billing features via `ctx.payments`.)
 *
 * The meter set is the full Cloudflare rate card (`src/billing/spend.ts`), so
 * the cap sees storage, Durable Object duration, D1 rows, and R2 operations —
 * not only requests and CPU.
 */

/**
 * The metered dimension. Mirrors `usageMeter` in `schema.ts` (which codegen
 * reads statically) and `UsageMeter` in `src/billing/spend.ts` (which prices
 * it); the three are pinned together by the type assertion in
 * `__tests__/spend.test.ts`.
 */
const kind = v.union(
    v.literal("aeDataPoints"),
    v.literal("aeReadQueries"),
    v.literal("browserHours"),
    v.literal("containerCpuSeconds"),
    v.literal("containerDiskGbSeconds"),
    v.literal("containerMemoryGibSeconds"),
    v.literal("cpuMs"),
    v.literal("d1RowsRead"),
    v.literal("d1RowsWritten"),
    v.literal("d1StorageGbMonths"),
    v.literal("doDurationGbS"),
    v.literal("doRequests"),
    v.literal("doRowsRead"),
    v.literal("doRowsWritten"),
    v.literal("doStorageGbMonths"),
    v.literal("imagesDelivered"),
    v.literal("imagesStored"),
    v.literal("imagesTransformations"),
    v.literal("kvDeletes"),
    v.literal("kvLists"),
    v.literal("kvReads"),
    v.literal("kvStorageGbMonths"),
    v.literal("kvWrites"),
    v.literal("logEvents"),
    v.literal("logpushRequests"),
    v.literal("queueOperations"),
    v.literal("r2ClassAOps"),
    v.literal("r2ClassBOps"),
    v.literal("r2StorageGbMonths"),
    v.literal("requests"),
    v.literal("vectorizeQueriedDimensions"),
    v.literal("vectorizeStoredDimensions"),
    v.literal("workersAiNeurons"),
    v.literal("workflowSteps"),
    v.literal("workflowStorageGbMonths"),
);

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
            createdAt: context.now,
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
    .use(rateLimit("ingest"))
    .input({
        deployKey: boundedString(LIMITS.token),
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"platformUsage">> => {
        await authorizeDeployKey(context, arguments_.organizationId, arguments_.deployKey, "org-wide");

        // The deploy key is tenant-held (CI), so a tenant could otherwise POST a
        // NEGATIVE quantity to deflate its own metered usage and defeat spend-cap
        // suspension / prepaid-overage debits (which sum this directly). Reject
        // negative/non-finite quantities and non-finite period timestamps.
        if (!Number.isFinite(arguments_.quantity) || arguments_.quantity < 0) {
            throw new LunoraError("BAD_REQUEST", "usage quantity must be a non-negative number");
        }

        if (!Number.isFinite(arguments_.periodStart) || arguments_.periodStart < 0) {
            throw new LunoraError("BAD_REQUEST", "usage periodStart must be a valid timestamp");
        }

        // The id is caller-supplied and only its ORG is authorized above, so
        // without this a tenant could attribute its rows to another org's
        // deployment. Reads stay org-scoped either way — the damage is
        // attribution, which for the usage ledger is the number a bill is
        // computed from.
        if (arguments_.deploymentId !== undefined) {
            await assertRowInOrg(context, arguments_.deploymentId, arguments_.organizationId, "deployment");
        }

        return context.db.insert("platformUsage", {
            createdAt: context.now,
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
    kind: UsageMeter;
    organizationId: Id<"organizations">;
    periodStart: number;
    quantity: number;
}

/** Rows one roll-up tick compacts. Bounds a single mutation; a backlog drains over ticks. */
const ROLLUP_BATCH = 1000;

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
    // Closed periods only, chosen in the QUERY. Filtering after a `findMany({})` read
    // one 1000-row page of arbitrary rows, so once the table outgrew that cap the
    // compaction stalled on whatever happened to sort first and never reached the
    // closed periods it exists to collapse. Oldest period first, bounded per tick.
    //
    // A group split across two ticks is fine: compaction is convergent, because each
    // tick collapses whatever survivors it sees into one row and the next tick
    // collapses those. The invariant that must hold within a tick — delete the extras
    // before patching the survivor — is unaffected by where the page boundary falls.
    const { page: closed } = await context.db.platformUsage.findMany({
        limit: ROLLUP_BATCH,
        orderBy: [{ periodStart: "asc" }],
        where: { periodStart: { lt: cutoff } },
    });

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
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<UsageTotals> => {
        await assertMember(context, organizationId);

        // The invoice-facing total, so it drains: the current period is not compacted by
        // `rollup`, and one page stops at 1000 rows — a busy org would under-report.
        const rows = await collectAll<PlatformUsageRow>((cursor) => context.db.platformUsage.findMany({ cursor, where: { organizationId, periodStart } }));

        return aggregateUsage(rows, periodStart);
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
    // Both reads drain every page. A single `findMany({})` page stops at 1000 rows, so
    // any organization past that boundary was never evaluated and its spend cap simply
    // did not apply — silently, since the sweep still reported success. The usage read
    // also narrows to the current period in the query, so draining stays proportional
    // to live spend rather than to all metering history.
    const usageRows = await collectAll<PlatformUsageRow>((cursor) =>
        context.db.platformUsage.findMany({ cursor, where: { periodStart: { gte: periodStart } } }),
    );
    const byOrg = new Map<string, PeriodUsage>();

    // Every meter counts toward the cap, not just requests/CPU — a tenant can
    // run away on Durable Object duration or R2 operations without moving the
    // compute meters at all. Unknown kinds (a row from a newer writer) are
    // skipped rather than throwing: the sweep that protects the platform from a
    // runaway bill must never be the thing that crashes.
    for (const row of usageRows) {
        if (!isUsageMeter(row.kind)) {
            continue;
        }

        const bucket = byOrg.get(row.organizationId) ?? {};

        bucket[row.kind] = (bucket[row.kind] ?? 0) + row.quantity;
        byOrg.set(row.organizationId, bucket);
    }

    const organizations = await collectAll<{
        _id: string;
        plan: string;
        spendCapMinor?: number;
        suspendedAt?: number;
        suspendedReason?: string;
    }>((cursor) => context.db.organizations.findMany({ cursor }));

    let suspended = 0;
    let unsuspended = 0;

    for (const organization of organizations) {
        const usage = byOrg.get(organization._id) ?? {};
        const decision = evaluateSpendCap({ capMinorOverride: organization.spendCapMinor, plan: organization.plan, usage });

        if (decision.suspend && organization.suspendedAt == null) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organization._id as Id<"organizations">, { suspendedAt: context.now, suspendedReason: "spend-cap" });
            // eslint-disable-next-line no-await-in-loop -- one audit row per transition
            await context.db.insert("auditLog", {
                action: "organization.suspend",
                actorUserId: "system:spend-cap",
                createdAt: context.now,
                organizationId: organization._id,
                target: `spend ${String(decision.spendMinor)} >= cap ${String(decision.capMinor)}`,
            });
            suspended += 1;
        } else if (!decision.suspend && organization.suspendedAt != null && organization.suspendedReason === "spend-cap") {
            // Only lift our own suspensions — dunning/support ones stay (GAPS.md C2).
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organization._id as Id<"organizations">, { suspendedAt: null, suspendedReason: null });
            unsuspended += 1;
        }
    }

    return { suspended, unsuspended };
});

/**
 * The overage-debit watermark for (org, period) — how many prepaid credits
 * previous reconciliation runs already debited (GAPS.md C3 follow-up).
 * SYSTEM only (reconciliation dispatch).
 */
export const overageWatermark = internalQuery
    .input({ organizationId: v.id("organizations"), periodStart: v.number() })
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<{ debitedCredits: number }> => {
        const { page } = await context.db.overageDebits.findMany({ where: { organizationId, periodStart } });
        const row = page[0];

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
        const row = page[0];
        const { now } = context;

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
 *
 * `requests`/`cpuMs` stay as named columns because they are the two the chart
 * plots, but `costMinor` prices the day's *whole* bucket across the rate card —
 * otherwise a day whose spend was all Durable Object duration would draw as a
 * flat line at zero.
 */
export const series = query
    .input({ organizationId: v.id("organizations"), periodStart: v.number() })
    .query(async ({ ctx: context, args: { organizationId, periodStart } }): Promise<{ costMinor: number; cpuMs: number; day: number; requests: number }[]> => {
        await assertMember(context, organizationId);

        const { page } = await context.db.platformUsage.findMany({ where: { organizationId, periodStart } });
        const dayMs = 24 * 60 * 60 * 1000;
        const buckets = new Map<number, PeriodUsage>();

        for (const row of page) {
            if (!isUsageMeter(row.kind)) {
                continue;
            }

            const day = Math.floor(row.createdAt / dayMs) * dayMs;
            const bucket = buckets.get(day) ?? {};

            bucket[row.kind] = (bucket[row.kind] ?? 0) + row.quantity;
            buckets.set(day, bucket);
        }

        return [...buckets.entries()]
            .map(([day, bucket]) => {
                return { costMinor: estimatedSpendMinor(bucket), cpuMs: bucket.cpuMs ?? 0, day, requests: bucket.requests ?? 0 };
            })
            .toSorted((a, b) => a.day - b.day);
    });
