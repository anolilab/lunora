import { describe, expect, it } from "vitest";

import { USAGE_METERS } from "../src/billing/spend";
import type { UsageEvent } from "../src/billing/usage";
import { aggregateUsage, emptyUsageTotals, toPeriodUsage } from "../src/billing/usage";

const events: UsageEvent[] = [
    { kind: "requests", periodStart: 1000, quantity: 5 },
    { kind: "requests", periodStart: 1000, quantity: 3 },
    { kind: "cpuMs", periodStart: 1000, quantity: 120 },
    { kind: "doRowsWritten", periodStart: 1000, quantity: 42 },
    { kind: "r2StorageGbMonths", periodStart: 1000, quantity: 7 },
    { kind: "requests", periodStart: 2000, quantity: 99 }, // different period — excluded
];

describe(aggregateUsage, () => {
    it("sums quantities per meter for the given period only", () => {
        const totals = aggregateUsage(events, 1000);

        expect(totals).toStrictEqual({ ...emptyUsageTotals(), cpuMs: 120, doRowsWritten: 42, r2StorageGbMonths: 7, requests: 8 });
    });

    it("returns a zeroed total for every meter when nothing matches the period", () => {
        const totals = aggregateUsage(events, 5000);

        expect(totals).toStrictEqual(emptyUsageTotals());
        expect(Object.keys(totals)).toHaveLength(USAGE_METERS.length);
    });

    /**
     * The cap sweep reads this. A ledger row written by a newer control plane
     * (a meter this build does not know) must be skipped, not thrown on — the
     * sweep that stops a runaway bill is the last thing that should crash on
     * unexpected data.
     */
    it("skips rows whose kind is not a known meter", () => {
        const unknown = [{ kind: "storageBytes", periodStart: 1000, quantity: 999 } as unknown as UsageEvent];

        expect(aggregateUsage(unknown, 1000)).toStrictEqual(emptyUsageTotals());
    });
});

describe(toPeriodUsage, () => {
    it("drops the zero meters so the cost model iterates only real usage", () => {
        expect(toPeriodUsage(aggregateUsage(events, 1000))).toStrictEqual({ cpuMs: 120, doRowsWritten: 42, r2StorageGbMonths: 7, requests: 8 });
    });
});
