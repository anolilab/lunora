import { describe, expect, expectTypeOf, it } from "vitest";

import type { Doc } from "../lunora/_generated/dataModel.js";
import type { UsageMeter } from "../src/billing/spend";
import {
    DEFAULT_SPEND_CAP_MINOR,
    estimatedSpendMinor,
    estimatedSpendNanoCents,
    evaluateSpendCap,
    isUsageMeter,
    RATE_CARD,
    spendBreakdown,
    USAGE_METERS,
} from "../src/billing/spend";

/** Aggregate spend caps over the full Cloudflare bill (GAPS.md C1). */

describe("rate card", () => {
    /**
     * The ledger's `kind` union is spelled out in `lunora/schema.ts` (codegen
     * reads it statically, so it cannot import the type) and priced by
     * `UsageMeter`. Nothing at runtime couples them, so this assertion is what
     * turns "added a meter and forgot the schema" into a `lint:types` failure
     * instead of a row the cap silently skips.
     */
    it("prices exactly the meters the ledger can hold", () => {
        expectTypeOf<Doc<"platformUsage">["kind"]>().toEqualTypeOf<UsageMeter>();

        expect(USAGE_METERS).toHaveLength(Object.keys(RATE_CARD).length);
    });

    it("holds every rate as a positive integer number of nano-cents", () => {
        for (const meter of USAGE_METERS) {
            const rate = RATE_CARD[meter];

            expect(Number.isInteger(rate.nanoCentsPerUnit), `${meter} rate must be an integer`).toBe(true);
            expect(rate.nanoCentsPerUnit).toBeGreaterThan(0);
            expect(rate.published).not.toBe("");
            expect(rate.product).not.toBe("");
        }
    });

    it("recognizes known meters and rejects unknown ones", () => {
        expect(isUsageMeter("doRowsWritten")).toBe(true);
        expect(isUsageMeter("storageBytes")).toBe(false);
    });
});

describe(estimatedSpendMinor, () => {
    it("prices compute at the Workers-for-Platforms basis", () => {
        // 100M requests = $30 = 3000 cents; 100M CPU-ms = $2 = 200 cents.
        expect(estimatedSpendMinor({ requests: 100_000_000 })).toBe(3000);
        expect(estimatedSpendMinor({ cpuMs: 100_000_000 })).toBe(200);
        expect(estimatedSpendMinor({})).toBe(0);
    });

    it("prices the storage-shaped dimensions the old model was blind to", () => {
        // 1M Durable Object rows written at $1.00/M.
        expect(estimatedSpendMinor({ doRowsWritten: 1_000_000 })).toBe(100);
        // 100 GB-month of R2 standard storage at $0.015/GB-mo = $1.50.
        expect(estimatedSpendMinor({ r2StorageGbMonths: 100 })).toBe(150);
        // 1M Durable Object GB-seconds at $12.50/M GB-s.
        expect(estimatedSpendMinor({ doDurationGbS: 1_000_000 })).toBe(1250);
        // 1M R2 Class A operations at $4.50/M.
        expect(estimatedSpendMinor({ r2ClassAOps: 1_000_000 })).toBe(450);
        // 1M Neurons at $0.011 / 1,000 = $11.00.
        expect(estimatedSpendMinor({ workersAiNeurons: 1_000_000 })).toBe(1100);
    });

    it("sums across meters", () => {
        expect(estimatedSpendMinor({ cpuMs: 100_000_000, doRowsWritten: 1_000_000, requests: 100_000_000 })).toBe(3000 + 200 + 100);
    });

    it("accumulates sub-cent meters instead of rounding each to zero", () => {
        // 10,000 row reads is 1,000,000 nano-cents — a ten-thousandth of a cent.
        // Rounding per meter would lose it; rounding the nano-cent total keeps it.
        expect(estimatedSpendNanoCents({ d1RowsRead: 10_000 })).toBe(1_000_000);
        expect(estimatedSpendMinor({ d1RowsRead: 10_000 })).toBe(0);
        // 50 billion row reads is $50 — visible only because the small ones added up.
        expect(estimatedSpendMinor({ d1RowsRead: 50_000_000_000 })).toBe(5000);
    });

    it("ignores negative and non-finite quantities", () => {
        expect(estimatedSpendMinor({ requests: -100_000_000 })).toBe(0);
        expect(estimatedSpendMinor({ requests: Number.NaN })).toBe(0);
        expect(estimatedSpendMinor({ requests: Number.POSITIVE_INFINITY })).toBe(0);
    });
});

describe(spendBreakdown, () => {
    it("orders lines by cost and omits meters with no usage", () => {
        const lines = spendBreakdown({ cpuMs: 100_000_000, doRowsWritten: 1_000_000, r2ClassBOps: 0, requests: 100_000_000 });

        expect(lines.map((line) => line.meter)).toStrictEqual(["requests", "cpuMs", "doRowsWritten"]);
        expect(lines[0]?.product).toBe("Workers for Platforms");
        expect(lines[0]?.quantity).toBe(100_000_000);
    });

    it("sums to the same total the cap evaluates", () => {
        const usage = { cpuMs: 12_345_678, doDurationGbS: 4321, doRowsRead: 987_654_321, requests: 5_555_555 };
        const summed = spendBreakdown(usage).reduce((total, line) => total + line.nanoCents, 0);

        expect(summed).toBe(estimatedSpendNanoCents(usage));
    });
});

describe(evaluateSpendCap, () => {
    it("suspends a free org past the default cap and not below it", () => {
        const over = evaluateSpendCap({ plan: "free", usage: { requests: 20_000_000 } }); // ~$6

        expect(over.suspend).toBe(true);
        expect(over.capMinor).toBe(DEFAULT_SPEND_CAP_MINOR["free"]);

        const under = evaluateSpendCap({ plan: "free", usage: { requests: 1_000_000 } }); // ~$0.30

        expect(under.suspend).toBe(false);
    });

    it("catches a runaway that never touches the compute meters", () => {
        // No requests, no CPU — just Durable Object duration. Under the old
        // requests+CPU-only model this org was invisible to the cap forever.
        const decision = evaluateSpendCap({ plan: "free", usage: { doDurationGbS: 10_000_000 } }); // $125

        expect(decision.spendMinor).toBe(12_500);
        expect(decision.suspend).toBe(true);
    });

    it("never suspends enterprise (uncapped default)", () => {
        const decision = evaluateSpendCap({ plan: "enterprise", usage: { cpuMs: 1e12, requests: 1e12 } });

        expect(decision.suspend).toBe(false);
        expect(decision.capMinor).toBeNull();
    });

    it("honors an org override, and treats an explicit 0 as uncapped", () => {
        const tightened = evaluateSpendCap({ capMinorOverride: 100, plan: "pro", usage: { requests: 10_000_000 } }); // ~$3

        expect(tightened.suspend).toBe(true);

        const uncapped = evaluateSpendCap({ capMinorOverride: 0, plan: "free", usage: { requests: 1e12 } });

        expect(uncapped.suspend).toBe(false);
        expect(uncapped.capMinor).toBeNull();
    });

    it("caps unknown plans at the free default (never uncapped by accident)", () => {
        const decision = evaluateSpendCap({ plan: "mystery", usage: { requests: 20_000_000 } });

        expect(decision.suspend).toBe(true);
        expect(decision.capMinor).toBe(DEFAULT_SPEND_CAP_MINOR["free"]);
    });
});
