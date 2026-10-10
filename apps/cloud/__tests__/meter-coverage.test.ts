import { describe, expect, it } from "vitest";

import { isUsageMeter, RATE_CARD, USAGE_METERS } from "../src/billing/spend";
import { isMeasuredMeter, meterCoverage, UNMEASURED_METERS, unmeasuredMeters, UNVERIFIED_METERS } from "../src/billing/usage";
import { FAMILY_METERS, USAGE_FAMILIES } from "../src/targets/driver";

/**
 * Coverage (issue #687): the spend cap prices every rate-card meter, but only a
 * readback family can observe one. Every meter must be exactly one of
 * "measured by a family" or "listed as unmeasured with a reason", so a new meter
 * cannot silently go missing from the bill.
 */
describe("meter coverage", () => {
    const measured = new Set<string>(USAGE_FAMILIES.flatMap((family) => FAMILY_METERS[family]));

    it("maps only known meters in the family table", () => {
        for (const meter of measured) {
            expect(isUsageMeter(meter), `${meter} is not on the rate card`).toBe(true);
        }
    });

    it("gives every rate-card meter exactly one coverage: measured or unmeasured", () => {
        for (const meter of USAGE_METERS) {
            const unmeasured = meter in UNMEASURED_METERS;

            expect(measured.has(meter), `${meter} must be measured or listed as unmeasured, not both or neither`).toBe(!unmeasured);
        }
    });

    it("lists no unmeasured meter that is not on the rate card", () => {
        for (const meter of Object.keys(UNMEASURED_METERS)) {
            expect(isUsageMeter(meter), `${meter} is not on the rate card`).toBe(true);
        }
    });

    it("gives every unmeasured meter a non-empty reason", () => {
        for (const line of unmeasuredMeters()) {
            expect(line.reason, `${line.meter} needs a reason`).not.toBe("");
            expect(line.product).toBe(RATE_CARD[line.meter].product);
        }
    });

    it("keeps the alert-only meters inside the measured set", () => {
        for (const meter of UNVERIFIED_METERS) {
            expect(isMeasuredMeter(meter), `${meter} is alert-only but not measured`).toBe(true);
        }
    });

    it("classifies a measured billed meter as enforced, a verified-pending one as alert-only, and the rest as unmeasured", () => {
        expect(meterCoverage("requests")).toBe("enforced");
        expect(meterCoverage("d1RowsRead")).toBe("enforced");
        expect(meterCoverage("cpuMs")).toBe("alert-only");
        expect(meterCoverage("doRequests")).toBe("alert-only");
        expect(meterCoverage("kvReads")).toBe("unmeasured");
    });
});
