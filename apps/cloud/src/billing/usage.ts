/**
 * Usage metering aggregation (CLOUD-PLAN.md §4). Metered events are summed per
 * billing period to drive quota + overage billing through `@lunora/payment`.
 * Pure — the control plane records events; this rolls them up.
 *
 * The meter set is {@link UsageMeter} from the rate card, so the ledger and the
 * cost model can never drift apart: a meter the ledger can hold is a meter the
 * rate card prices, and vice versa.
 */

import type { PeriodUsage, UsageMeter } from "./spend";
import { isUsageMeter, USAGE_METERS } from "./spend";

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
