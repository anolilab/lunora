/**
 * Usage metering aggregation (CLOUD-PLAN.md §4). Metered events are summed per
 * billing period to drive quota + overage billing through `@lunora/payment`.
 * Pure — the control plane records events; this rolls them up.
 */

export type UsageKind = "cpuMs" | "requests" | "storageBytes";

export interface UsageEvent {
    kind: UsageKind;
    periodStart: number;
    quantity: number;
}

export type UsageTotals = Record<UsageKind, number>;

/** Sum the metered quantities for `periodStart`, by kind. */
export const aggregateUsage = (events: ReadonlyArray<UsageEvent>, periodStart: number): UsageTotals => {
    const totals: UsageTotals = { cpuMs: 0, requests: 0, storageBytes: 0 };

    for (const event of events) {
        if (event.periodStart === periodStart) {
            totals[event.kind] += event.quantity;
        }
    }

    return totals;
};
