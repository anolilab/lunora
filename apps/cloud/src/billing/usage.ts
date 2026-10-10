/**
 * Usage metering aggregation. Metered events are summed per
 * billing period to drive quota + overage billing through `@lunora/payment`.
 * Pure — the control plane records events; this rolls them up.
 *
 * The meter set is {@link UsageMeter} from the rate card, so the ledger and the
 * cost model can never drift apart: a meter the ledger can hold is a meter the
 * rate card prices, and vice versa.
 */

import type { TargetId } from "../provision-contract";
import { TARGETS } from "../provision-contract";
import type { FAMILY_METERS, UsageFamily } from "../targets/driver";
import type { PeriodUsage, UsageMeter } from "./spend";
import { isUsageMeter, RATE_CARD, USAGE_METERS } from "./spend";

export type UsageKind = UsageMeter;

export interface UsageEvent {
    kind: UsageKind;
    periodStart: number;
    quantity: number;
}

/** Every meter, zero-filled — a stable shape so the console table never gains/loses columns. */
export type UsageTotals = Record<UsageKind, number>;

/** All meters at zero. */
export const emptyUsageTotals = (): UsageTotals => {
    const totals = {} as UsageTotals;

    for (const meter of USAGE_METERS) {
        totals[meter] = 0;
    }

    return totals;
};

/**
 * Sum the metered quantities for `periodStart`, by kind. Rows carrying a kind
 * the rate card does not know are skipped rather than crashing the roll-up —
 * a ledger written by a newer writer must not be able to break the cap sweep
 * that protects the platform from a runaway bill.
 */
export const aggregateUsage = (events: ReadonlyArray<UsageEvent>, periodStart: number): UsageTotals => {
    const totals = emptyUsageTotals();

    for (const event of events) {
        if (event.periodStart === periodStart && isUsageMeter(event.kind)) {
            totals[event.kind] += event.quantity;
        }
    }

    return totals;
};

/**
 * Whether a `platformUsage` row counts toward what an organization is billed —
 * its spend cap, its overage debit and its invoice summary. A row is billable
 * unless its writer stored `billable: false`: counts from a host the
 * organization owns are display only ({@link isBilledTarget}).
 *
 * NULL off a `.global()` row and `undefined` both mean the column is unset.
 */
export const isBillableUsage = (row: { billable?: boolean | null }): boolean => row.billable !== false;

/**
 * Whether the requests of a `target`'s tenants are billed by Lunora Cloud: only
 * a cell-placed target's, which run on the platform's own account. A tenant on
 * a host its organization owns is billed by nobody here — a box's counts come
 * from a machine the customer has root on (plan 458 D12), and a connected
 * Cloudflare account's are on the customer's own Cloudflare bill — so its rows
 * are written `billable: false`.
 */
export const isBilledTarget = (target: TargetId): boolean => TARGETS[target].placedOn === "cell";

/**
 * Meters the readback writes but does not bill yet: **alert-only until
 * verified against a live Cloudflare account.** Their source fields are found
 * by schema introspection (`src/cloudflare/compute-usage.ts`), and neither the
 * field names, their units nor the dispatch-namespace attribution have been
 * compared with a real account. So on every target their rows are written
 * `billable: false`: they feed usage alerts, anomaly scores, the Usage tab and
 * the threshold suggestion, and never the spend accrual, admission,
 * `usage.enforceSpendCaps` or the overage debit.
 *
 * Empty this set only after the first live readback has been compared with
 * Cloudflare's own dashboard for the same hours (Workers for Platforms CPU
 * time; Durable Objects requests and duration), on the platform cell. Rows
 * written before then stay display-only; that under-bills, the fail-safe
 * direction. A tenant's own `usage.ingest` reports are not readback rows and
 * are not affected.
 */
export const UNVERIFIED_METERS: ReadonlySet<UsageMeter> = new Set<UsageMeter>(["cpuMs", "doDurationGbS", "doRequests"]);

/**
 * Whether a readback row of `meter` for a `target`'s tenant is billed: the
 * target must be billed ({@link isBilledTarget}) and the meter verified
 * ({@link UNVERIFIED_METERS}).
 */
export const isBilledReadback = (target: TargetId, meter: UsageMeter): boolean => isBilledTarget(target) && !UNVERIFIED_METERS.has(meter);

/** A meter some readback family measures ({@link FAMILY_METERS}). */
export type MeasuredMeter = (typeof FAMILY_METERS)[UsageFamily][number];

/**
 * Meters the platform does not measure, each with the reason. A meter lands here
 * when no readback family writes it. Most need a reader whose GraphQL or Analytics
 * Engine fields are not yet verified against a live account (the introspection
 * probes in `src/cloudflare/`). The storage gauges (`*StorageGbMonths`,
 * `vectorizeStoredDimensions`, `imagesStored`) are point-in-time sizes, not
 * counters, so they need a periodic sample and a ledger decision first.
 *
 * Nothing reads them back, so their usage is absent from the spend cap. A tenant
 * can still self-report one through `usage.ingest`; that row is priced and counted
 * like any other, and the platform does not verify it.
 */
export const UNMEASURED_METERS = {
    aeDataPoints: "Analytics Engine data points are not read back per tenant",
    aeReadQueries: "Analytics Engine read queries are not read back per tenant",
    browserHours: "Browser Rendering hours are not read back",
    containerCpuSeconds: "Container CPU is not read back",
    containerDiskGbSeconds: "Container disk is not read back",
    containerMemoryGibSeconds: "Container memory is not read back",
    d1StorageGbMonths: "D1 storage is a gauge; it needs a periodic sample, not a counter",
    doStorageGbMonths: "Durable Object storage is a gauge; it needs a periodic sample, not a counter",
    imagesDelivered: "Images deliveries are not read back",
    imagesStored: "Stored images are a gauge; they need a periodic sample, not a counter",
    imagesTransformations: "Image transformations are not read back",
    kvDeletes: "Workers KV operations are not read back",
    kvLists: "Workers KV operations are not read back",
    kvReads: "Workers KV operations are not read back",
    kvStorageGbMonths: "Workers KV storage is a gauge; it needs a periodic sample, not a counter",
    kvWrites: "Workers KV operations are not read back",
    logEvents: "Workers Logs events are not read back",
    logpushRequests: "Logpush requests are not read back",
    queueOperations: "Queue operations are not read back",
    r2ClassAOps: "R2 operations are not read back",
    r2ClassBOps: "R2 operations are not read back",
    r2StorageGbMonths: "R2 storage is a gauge; it needs a periodic sample, not a counter",
    vectorizeQueriedDimensions: "Vectorize queries are not read back",
    vectorizeStoredDimensions: "Vectorize storage is a gauge; it needs a periodic sample, not a counter",
    workersAiNeurons: "Workers AI usage is not read back",
    workflowSteps: "Workflow steps are not read back",
    workflowStorageGbMonths: "Workflow storage is a gauge; it needs a periodic sample, not a counter",
} as const satisfies Record<Exclude<UsageMeter, MeasuredMeter>, string>;

/** Whether a readback family measures `meter`. */
export const isMeasuredMeter = (meter: UsageMeter): meter is MeasuredMeter => !(meter in UNMEASURED_METERS);

/**
 * How a meter's usage reaches the bill: `enforced` counts toward the spend cap
 * and the overage debit; `alert-only` is written but never billed
 * ({@link UNVERIFIED_METERS}); `unmeasured` has no readback at all
 * ({@link UNMEASURED_METERS}).
 */
export type MeterCoverage = "alert-only" | "enforced" | "unmeasured";

export const meterCoverage = (meter: UsageMeter): MeterCoverage => {
    if (!isMeasuredMeter(meter)) {
        return "unmeasured";
    }

    return UNVERIFIED_METERS.has(meter) ? "alert-only" : "enforced";
};

/** One unmeasured meter, as the summary and the Usage tab show it. */
export interface UnmeasuredMeter {
    meter: UsageMeter;
    product: string;
    reason: string;
}

/** Every unmeasured meter in rate-card order, with its product and reason. */
export const unmeasuredMeters = (): UnmeasuredMeter[] =>
    Object.entries(UNMEASURED_METERS).map(([meter, reason]) => {
        return {
            meter: meter as UsageMeter,
            product: RATE_CARD[meter as UsageMeter].product,
            reason,
        };
    });

/** Drop the zero meters — the sparse form the cost model and breakdown take. */
export const toPeriodUsage = (totals: UsageTotals): PeriodUsage => {
    const usage: PeriodUsage = {};

    for (const meter of USAGE_METERS) {
        if (totals[meter] > 0) {
            usage[meter] = totals[meter];
        }
    }

    return usage;
};
