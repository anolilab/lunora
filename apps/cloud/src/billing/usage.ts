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
