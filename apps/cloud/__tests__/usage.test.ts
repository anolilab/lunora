import { describe, expect, it } from "vitest";

import type { UsageEvent } from "../src/billing/usage";
import { aggregateUsage } from "../src/billing/usage";

const events: UsageEvent[] = [
    { kind: "requests", periodStart: 1000, quantity: 5 },
    { kind: "requests", periodStart: 1000, quantity: 3 },
    { kind: "cpuMs", periodStart: 1000, quantity: 120 },
    { kind: "requests", periodStart: 2000, quantity: 99 }, // different period — excluded
];

describe(aggregateUsage, () => {
    it("sums quantities per kind for the given period only", () => {
        expect(aggregateUsage(events, 1000)).toStrictEqual({ cpuMs: 120, requests: 8, storageBytes: 0 });
    });

    it("returns a zeroed total when nothing matches the period", () => {
        expect(aggregateUsage(events, 5000)).toStrictEqual({ cpuMs: 0, requests: 0, storageBytes: 0 });
    });
});
