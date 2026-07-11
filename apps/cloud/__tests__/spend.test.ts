import { describe, expect, it } from "vitest";

import { DEFAULT_SPEND_CAP_MINOR, estimatedSpendMinor, evaluateSpendCap } from "../src/billing/spend";

/** Aggregate spend caps (GAPS.md C1). */

describe(evaluateSpendCap, () => {
    it("estimates spend at the WfP cost basis", () => {
        // 100M requests = $30 = 3000 cents; 100M cpu-ms = $2 = 200 cents.
        expect(estimatedSpendMinor({ cpuMs: 0, requests: 100_000_000 })).toBe(3000);
        expect(estimatedSpendMinor({ cpuMs: 100_000_000, requests: 0 })).toBe(200);
        expect(estimatedSpendMinor({ cpuMs: 0, requests: 0 })).toBe(0);
    });

    it("suspends a free org past the default cap and not below it", () => {
        const over = evaluateSpendCap({ plan: "free", usage: { cpuMs: 0, requests: 20_000_000 } }); // ~$6

        expect(over.suspend).toBe(true);
        expect(over.capMinor).toBe(DEFAULT_SPEND_CAP_MINOR["free"]);

        const under = evaluateSpendCap({ plan: "free", usage: { cpuMs: 0, requests: 1_000_000 } }); // ~$0.30

        expect(under.suspend).toBe(false);
    });

    it("never suspends enterprise (uncapped default)", () => {
        const decision = evaluateSpendCap({ plan: "enterprise", usage: { cpuMs: 1e12, requests: 1e12 } });

        expect(decision.suspend).toBe(false);
        expect(decision.capMinor).toBeNull();
    });

    it("honors an org override, and treats an explicit 0 as uncapped", () => {
        const tightened = evaluateSpendCap({ capMinorOverride: 100, plan: "pro", usage: { cpuMs: 0, requests: 10_000_000 } }); // ~$3

        expect(tightened.suspend).toBe(true);

        const uncapped = evaluateSpendCap({ capMinorOverride: 0, plan: "free", usage: { cpuMs: 0, requests: 1e12 } });

        expect(uncapped.suspend).toBe(false);
        expect(uncapped.capMinor).toBeNull();
    });

    it("caps unknown plans at the free default (never uncapped by accident)", () => {
        const decision = evaluateSpendCap({ plan: "mystery", usage: { cpuMs: 0, requests: 20_000_000 } });

        expect(decision.suspend).toBe(true);
        expect(decision.capMinor).toBe(DEFAULT_SPEND_CAP_MINOR["free"]);
    });
});
