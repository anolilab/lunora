import { describe, expect, it } from "vitest";

import { LEVEL_VARIANT, rateLevel, ratePercent, REQUEST_ERROR_CRIT, REQUEST_ERROR_WARN } from "../../../src/features/reports/slo-format";

describe("ratePercent", () => {
    it("renders a 0..1 rate to one decimal place", () => {
        expect.assertions(3);

        expect(ratePercent(1, 200)).toBe("0.5%");
        expect(ratePercent(4, 200)).toBe("2.0%");
        expect(ratePercent(200, 200)).toBe("100.0%");
    });

    it("reads as an em-dash when there has been no traffic", () => {
        expect.assertions(1);

        // Not "0.0%" — a rate over nothing is unknown, not healthy.
        expect(ratePercent(0, 0)).toBe("—");
    });
});

describe("rateLevel", () => {
    it("classifies at the boundaries inclusively", () => {
        expect.assertions(5);

        // The thresholds are "at or above", so a rate landing exactly on one breaches
        // into that level rather than staying under it.
        expect(rateLevel(0.009, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("ok");
        expect(rateLevel(REQUEST_ERROR_WARN, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("warn");
        expect(rateLevel(0.049, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("warn");
        expect(rateLevel(REQUEST_ERROR_CRIT, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("crit");
        expect(rateLevel(1, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("crit");
    });

    it("reads a rate over no traffic as ok rather than breaching", () => {
        expect.assertions(2);

        // Callers pass `errors / calls`; a zero denominator is no traffic, not a
        // breach. The health digest relies on this — it computes the rate without a
        // guard of its own.
        const untouched = { calls: 0, errors: 0 };

        expect(rateLevel(Number.NaN, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("ok");
        expect(rateLevel(untouched.errors / untouched.calls, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("ok");
    });

    it("still breaches when there are errors but no recorded calls", () => {
        expect.assertions(2);

        // `errors / 0` with errors > 0 is Infinity. Unlike 0/0 there IS something
        // wrong, so a missing denominator must not launder it into "ok".
        const failing = { calls: 0, errors: 3 };

        expect(rateLevel(Number.POSITIVE_INFINITY, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("crit");
        expect(rateLevel(failing.errors / failing.calls, REQUEST_ERROR_WARN, REQUEST_ERROR_CRIT)).toBe("crit");
    });
});

describe("levelVariant", () => {
    it("maps a breach to the destructive tone", () => {
        expect.assertions(3);

        // The tones carry the meaning at a glance, so they are worth pinning.
        expect(LEVEL_VARIANT.crit).toBe("destructive");
        expect(LEVEL_VARIANT.warn).toBe("default");
        expect(LEVEL_VARIANT.ok).toBe("secondary");
    });
});
