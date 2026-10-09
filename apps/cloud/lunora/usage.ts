import { LunoraError } from "@lunora/server";

import type { PeriodUsage, SpendAccrual, SpendCapDecision, SpendLevel, SpendLimits, SpendLine, UsageMeter } from "../src/billing/spend";
import {
    accruedSpend,
    estimatedSpendMinor,
    estimatedSpendNanoCents,
    evaluateSpendCap,
    isUsageMeter,
    MAX_SPEND_THRESHOLD_MINOR,
    periodStartOf,
    spendBreakdown,
} from "../src/billing/spend";
import type { UsageTotals } from "../src/billing/usage";
import { aggregateUsage, isBillableUsage } from "../src/billing/usage";
import type { SourceStatusRow } from "../src/metering/status";
import { meteringNotices } from "../src/metering/status";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx as MutationContext, QueryCtx as QueryContext } from "./_generated/server.js";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server.js";
import { fireSpendAlerts } from "./alerts";
import { assertMember, assertRowInOrg, authorizeBillingKey, authorizeDeployKeyRow } from "./authz";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * Platform resource metering. `record` is written by the
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

/**
 * Fold one billable ledger row into its org's running spend — the accrual the
 * dispatcher's plan lookup refuses an over-cap org on (plan 365 W3), between
 * hourly sweeps.
 *
 * ponytail: read-modify-write on the org row, so a concurrent writer outside
 * this serialized mutation (the readback sweep) can lose an increment. That
 * under-counts only the fast path; the hourly sweep rewrites the accrual from
 * the ledger, which stays the authority. A per-org counter DO if it matters.
 */
const accrueSpend = async (
    context: MutationContext,
    organizationId: Id<"organizations">,
    row: { kind: string; periodStart: number; quantity: number },
): Promise<void> => {
    const organization = (await context.db.get(organizationId)) as null | SpendAccrual;
    const next = organization === null ? null : accruedSpend(organization, row, context.now);

    if (next !== null) {
        await context.db.patch(organizationId, next);
    }
};

/** Record a metered event. SYSTEM only (internalMutation — cron/metering writer). */
export const record = internalMutation
    .input({
        deploymentId: v.optional(v.id("deployments")),
        kind,
        organizationId: v.id("organizations"),
        periodStart: v.number(),
        quantity: v.number(),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"platformUsage">> => {
        const id = await context.db.insert("platformUsage", {
            createdAt: context.now,
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: arguments_.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        });

        await accrueSpend(context, arguments_.organizationId, arguments_);

        return id;
    });

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
        const key = await authorizeDeployKeyRow(context, arguments_.organizationId, arguments_.deployKey, "org-wide");

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

        const id = await context.db.insert("platformUsage", {
            createdAt: context.now,
            deploymentId: arguments_.deploymentId,
            kind: arguments_.kind,
            organizationId: key.organizationId,
            periodStart: arguments_.periodStart,
            quantity: arguments_.quantity,
        });

        await accrueSpend(context, key.organizationId, arguments_);

        return id;
    });

interface PlatformUsageRow {
    _id: Id<"platformUsage">;
    /** `false` on a row that is displayed and never billed (`isBillableUsage`). */
    billable?: boolean | null;
    createdAt: number;
    kind: UsageMeter;
    organizationId: Id<"organizations">;
    periodStart: number;
    placementRef?: Id<"boxes"> | Id<"cloudflareAccounts"> | null;
    quantity: number;
}

/** Rows one roll-up tick compacts. Bounds a single mutation; a backlog drains over ticks. */
const ROLLUP_BATCH = 1000;

/** Epoch ms for the first instant of the current UTC month. */
const currentPeriodStart = (): number => periodStartOf(Date.now());

/**
 * Compact closed-period metering events. Per
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
        // Display-only rows compact among themselves, per host: folding one into
        // a billable row would bill it, and folding it away would lose what the
        // studio shows.
        const groupKey = `${row.organizationId}|${String(row.periodStart)}|${row.kind}|${String(isBillableUsage(row))}|${row.placementRef ?? ""}`;
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

        // What the org is billed on: counts from a host the org owns are display only.
        return aggregateUsage(
            rows.filter((row) => isBillableUsage(row)),
            periodStart,
        );
    });

/** The org's billable usage for one period, per meter — what the cap prices. Drains every page. */
const orgPeriodUsage = async (context: QueryContext, organizationId: Id<"organizations">, periodStart: number): Promise<PeriodUsage> => {
    const rows = await collectAll<PlatformUsageRow>((cursor) => context.db.platformUsage.findMany({ cursor, where: { organizationId, periodStart } }));
    const usage: PeriodUsage = {};

    for (const row of rows) {
        if (isUsageMeter(row.kind) && isBillableUsage(row)) {
            usage[row.kind] = (usage[row.kind] ?? 0) + row.quantity;
        }
    }

    return usage;
};

/** An org's current-period spend against its two thresholds, as the console's spend-limits card shows it. */
export interface SpendStatus extends SpendCapDecision {
    periodStart: number;
    /** True when the org set its own warn threshold (`spendWarnMinor`), false when it is the 80%-of-cap default. */
    warnCustomized: boolean;
}

/**
 * The org's current-period spend, cap, warn threshold and level (members) —
 * the same `evaluateSpendCap` the enforcement sweep runs, over the same rows,
 * so the console never shows a level the sweep would not act on.
 */
export const spendStatus = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<SpendStatus> => {
        const member = await assertMember(context, organizationId);
        const organization = (await context.db.get(member.organizationId)) as null | {
            plan: string;
            spendCapMinor?: null | number;
            spendWarnMinor?: null | number;
        };

        if (!organization) {
            throw new LunoraError("NOT_FOUND", "organization not found");
        }

        const periodStart = currentPeriodStart();
        const decision = evaluateSpendCap({
            capMinorOverride: organization.spendCapMinor,
            plan: organization.plan,
            usage: await orgPeriodUsage(context, member.organizationId, periodStart),
            warnMinorOverride: organization.spendWarnMinor,
        });

        return { ...decision, periodStart, warnCustomized: organization.spendWarnMinor != null };
    });

/** A metering source that cannot read right now, as the Usage tab warns about it. */
interface MeteringStatusNotice {
    family: "d1" | "durableObjects" | "requests";
    message: string;
    source: string;
}

/**
 * The metering sources that cannot read right now, for the org's Usage tab
 * (any member): the platform's own in the org's cell, and the org's connected
 * accounts. A source
 * that cannot read records its reason instead of reporting zero (the readback
 * sweep, `src/deploy/sweeps.ts`), so a usage figure that is missing a family is
 * never shown as complete.
 */
export const meteringStatus = query
    .input({ organizationId: v.id("organizations") })
    .query(async ({ ctx: context, args: { organizationId } }): Promise<MeteringStatusNotice[]> => {
        const member = await assertMember(context, organizationId);
        const organization = (await context.db.get(member.organizationId)) as null | { cellId: Id<"cells"> };
        const [statuses, accounts, cell] = await Promise.all([
            collectAll<SourceStatusRow>((cursor) => context.db.usageSourceStatus.findMany({ cursor })),
            collectAll<{ _id: string; label: string }>((cursor) =>
                context.db.cloudflareAccounts.findMany({ cursor, where: { organizationId: member.organizationId } }),
            ),
            organization === null ? null : (context.db.get(organization.cellId) as Promise<null | { name: string }>),
        ]);

        // The platform's own source is shown for the organization's cell only: its name is the `cloudflare-wfp` scope.
        return meteringNotices(statuses, accounts, cell?.name, context.now);
    });

/** Shortest elapsed span a projection extrapolates from, so the first minutes of a month do not project a runaway. */
const MIN_PROJECTION_ELAPSED_MS = 60 * 60 * 1000;

/** What an agent reads about one period's bill (`POST /v1/usage/summary`, Lago's `current_usage` shape). */
export interface BillingSummary extends SpendLimits {
    /** Per-meter cost, most expensive first — at most one line per rate-card meter. */
    breakdown: SpendLine[];
    level: SpendLevel;
    periodEnd: number;
    periodStart: number;
    /** The period's spend extrapolated linearly to its end; equal to `spendMinor` for a closed period. */
    projectedSpendMinor: number;
    spendMinor: number;
    suspended: boolean;
}

/**
 * One period's usage, estimated spend, thresholds, level and current-period
 * projection for an org (plan 365 W6) — the agent-facing read behind the
 * `usage.summary` MCP tool. SYSTEM (the route), authorized by an org-wide deploy
 * key; every row is read for the key's organization, never the request's.
 * `periodStart` must be a month start no later than the current one.
 */
export const billingSummary = internalQuery
    .input({ deployKey: boundedString(LIMITS.token), organizationId: v.id("organizations"), periodStart: v.optional(v.number()) })
    .query(async ({ ctx: context, args: { deployKey, organizationId, periodStart: requested } }): Promise<BillingSummary> => {
        const verified = await authorizeBillingKey(context, organizationId, deployKey);
        const current = periodStartOf(context.now);
        const periodStart = requested ?? current;

        if (!Number.isFinite(periodStart) || periodStart < 0 || periodStart > current || periodStartOf(periodStart) !== periodStart) {
            throw new LunoraError("BAD_REQUEST", "periodStart must be the first instant (UTC) of the current or an earlier month");
        }

        const organization = (await context.db.get(verified)) as null | {
            plan: string;
            spendCapMinor?: null | number;
            spendWarnMinor?: null | number;
            suspendedAt?: null | number;
        };

        if (!organization) {
            throw new LunoraError("NOT_FOUND", "organization not found");
        }

        const usage = await orgPeriodUsage(context, verified, periodStart);
        const decision = evaluateSpendCap({
            capMinorOverride: organization.spendCapMinor,
            plan: organization.plan,
            usage,
            warnMinorOverride: organization.spendWarnMinor,
        });
        // Any instant 32 days in falls in the next month; its month start is this period's end.
        const periodEnd = periodStartOf(periodStart + 32 * 24 * 60 * 60 * 1000);
        const elapsed = Math.max(context.now - periodStart, MIN_PROJECTION_ELAPSED_MS);
        const projectedSpendMinor =
            periodStart === current
                ? Math.round((decision.spendMinor * (periodEnd - periodStart)) / Math.min(elapsed, periodEnd - periodStart))
                : decision.spendMinor;

        return {
            breakdown: spendBreakdown(usage),
            capMinor: decision.capMinor,
            level: decision.level,
            periodEnd,
            periodStart,
            projectedSpendMinor,
            spendMinor: decision.spendMinor,
            suspended: organization.suspendedAt != null,
            warnMinor: decision.warnMinor,
        };
    });

/**
 * Set the org's soft-cap warning threshold in minor units (owners/admins): `0`
 * turns the warning off, `null` returns to the 80%-of-cap default. Only the
 * WARN threshold is tenant-settable — the cap is a platform blast-radius control
 * and stays support-only. Re-arms the once-per-period latch, so a threshold
 * moved above the current spend can still fire later this period.
 */
export const setSpendWarning = mutation
    .use(rateLimit("api"))
    .input({ organizationId: v.id("organizations"), warnMinor: v.union(v.number(), v.null()) })
    .mutation(async ({ ctx: context, args: { organizationId, warnMinor } }): Promise<void> => {
        const member = await assertMember(context, organizationId, ["owner", "admin"]);

        if (warnMinor !== null && (!Number.isInteger(warnMinor) || warnMinor < 0 || warnMinor > MAX_SPEND_THRESHOLD_MINOR)) {
            throw new LunoraError("BAD_REQUEST", `warnMinor must be a whole number of cents between 0 and ${String(MAX_SPEND_THRESHOLD_MINOR)}`);
        }

        await context.db.patch(member.organizationId, { spendWarnedPeriod: null, spendWarnMinor: warnMinor });
        await context.db.insert("auditLog", {
            action: "organization.spend_warn_set",
            actorUserId: member.userId,
            createdAt: context.now,
            organizationId: member.organizationId,
            target: warnMinor === null ? "default" : String(warnMinor),
        });
    });

/**
 * Enforce aggregate spend caps (GAPS.md C1). Estimates each org's current-
 * period spend from the metered platform usage and suspends orgs over their
 * cap (plan default or org override) — the dispatcher serves 503 for a
 * suspended org's tenants. Self-healing: orgs back under the cap (new period,
 * raised cap, upgraded plan) are unsuspended on the next run. SYSTEM only
 * (cron dispatch).
 */
export const enforceSpendCaps = internalMutation.mutation(async ({ ctx: context }): Promise<{ suspended: number; unsuspended: number; warned: number }> => {
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
        // Box-reported counts never move the spend cap (plan 458 D12).
        if (!isUsageMeter(row.kind) || !isBillableUsage(row)) {
            continue;
        }

        const bucket = byOrg.get(row.organizationId) ?? {};

        bucket[row.kind] = (bucket[row.kind] ?? 0) + row.quantity;
        byOrg.set(row.organizationId, bucket);
    }

    // `.global()` rows answer SQL NULL for an unset column, so every optional is `| null`.
    const organizations = await collectAll<{
        _id: Id<"organizations">;
        name: string;
        plan: string;
        spendCapMinor?: null | number;
        spendNanoCents?: null | number;
        spendPeriod?: null | number;
        spendWarnedPeriod?: null | number;
        spendWarnMinor?: null | number;
        suspendedAt?: null | number;
        suspendedReason?: null | string;
    }>((cursor) => context.db.organizations.findMany({ cursor }));

    let suspended = 0;
    let unsuspended = 0;
    let warned = 0;

    for (const organization of organizations) {
        const organizationId = organization._id;
        const usage = byOrg.get(organizationId) ?? {};
        const decision = evaluateSpendCap({
            capMinorOverride: organization.spendCapMinor,
            plan: organization.plan,
            usage,
            warnMinorOverride: organization.spendWarnMinor,
        });
        const audit = async (action: string, target: string): Promise<void> => {
            await context.db.insert("auditLog", { action, actorUserId: "system:spend-cap", createdAt: context.now, organizationId, target });
        };
        const spendNanoCents = estimatedSpendNanoCents(usage);

        // The ledger is the authority: rewrite the admission fast path's running
        // accrual (plan 365 W3) from it, correcting any increment a racing writer lost.
        if (organization.spendPeriod !== periodStart || organization.spendNanoCents !== spendNanoCents) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organizationId, { spendNanoCents, spendPeriod: periodStart });
        }

        if (decision.level === "breach" && organization.suspendedAt == null) {
            // The warn latch is stamped with the suspension, so recovering inside the
            // same period (a raised cap) does not then fire a stale soft-cap warning.
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organizationId, { spendWarnedPeriod: periodStart, suspendedAt: context.now, suspendedReason: "spend-cap" });
            // eslint-disable-next-line no-await-in-loop -- one audit row per transition
            await audit("organization.suspend", `spend ${String(decision.spendMinor)} >= cap ${String(decision.capMinor)}`);
            // eslint-disable-next-line no-await-in-loop -- one alert fan-out per transition
            await fireSpendAlerts(context, organizationId, periodStart, {
                level: "breach",
                organization: organization.name,
                spendMinor: decision.spendMinor,
                thresholdMinor: decision.capMinor ?? 0,
            });
            suspended += 1;
        } else if (decision.level !== "breach" && organization.suspendedAt != null && organization.suspendedReason === "spend-cap") {
            // Only lift our own suspensions — dunning/support ones stay (GAPS.md C2).
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organizationId, { suspendedAt: null, suspendedReason: null });
            // eslint-disable-next-line no-await-in-loop -- one audit row per transition
            await audit("organization.unsuspend", `spend ${String(decision.spendMinor)} < cap ${String(decision.capMinor)}`);
            unsuspended += 1;
        }

        // Soft cap (plan 365 D3): a notification, never an action — once per period.
        if (decision.level === "warn" && organization.spendWarnedPeriod !== periodStart) {
            // eslint-disable-next-line no-await-in-loop -- small batch; sequential keeps the writer simple
            await context.db.patch(organizationId, { spendWarnedPeriod: periodStart });
            // eslint-disable-next-line no-await-in-loop -- one audit row per transition
            await audit("organization.spend_warn", `spend ${String(decision.spendMinor)} >= warn ${String(decision.warnMinor)}`);
            // eslint-disable-next-line no-await-in-loop -- one alert fan-out per transition
            await fireSpendAlerts(context, organizationId, periodStart, {
                level: "warn",
                organization: organization.name,
                spendMinor: decision.spendMinor,
                thresholdMinor: decision.warnMinor ?? 0,
            });
            warned += 1;
        }
    }

    return { suspended, unsuspended, warned };
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
        // Requests a customer box reported, or read back from a connected account: plotted, never priced.
        const boxRequests = new Map<number, number>();

        for (const row of page as PlatformUsageRow[]) {
            if (!isUsageMeter(row.kind)) {
                continue;
            }

            const day = Math.floor(row.createdAt / dayMs) * dayMs;

            if (isBillableUsage(row)) {
                const bucket = buckets.get(day) ?? {};

                bucket[row.kind] = (bucket[row.kind] ?? 0) + row.quantity;
                buckets.set(day, bucket);
            } else if (row.kind === "requests") {
                boxRequests.set(day, (boxRequests.get(day) ?? 0) + row.quantity);
                buckets.set(day, buckets.get(day) ?? {});
            }
        }

        return [...buckets.entries()]
            .map(([day, bucket]) => {
                return {
                    costMinor: estimatedSpendMinor(bucket),
                    cpuMs: bucket.cpuMs ?? 0,
                    day,
                    requests: (bucket.requests ?? 0) + (boxRequests.get(day) ?? 0),
                };
            })
            .toSorted((a, b) => a.day - b.day);
    });
