import { describe, expect, it } from "vitest";

import { formatElapsed, formatLatency, hitRate } from "../../../src/features/reports/metrics-format";

describe("formatLatency", () => {
    it("switches unit at the millisecond and second boundaries", () => {
        expect.assertions(6);

        // Sub-millisecond latencies are the common case for a DO read, so they get
        // microseconds rather than rounding to "0.0ms".
        expect(formatLatency(0.4)).toBe("400μs");
        expect(formatLatency(0.999)).toBe("999μs");
        expect(formatLatency(1)).toBe("1.0ms");
        expect(formatLatency(999.4)).toBe("999.4ms");
        expect(formatLatency(1000)).toBe("1.00s");
        expect(formatLatency(2500)).toBe("2.50s");
    });

    it("reads as an em-dash when there is no measurement", () => {
        expect.assertions(2);

        // Zero here means "not recorded", not "instant" — the metrics buffer reports 0
        // for a percentile it has no samples for.
        expect(formatLatency(0)).toBe("—");
        expect(formatLatency(-1)).toBe("—");
    });
});

describe("formatElapsed", () => {
    it("drops to the two largest useful units", () => {
        expect.assertions(5);

        expect(formatElapsed(5000)).toBe("5s");
        expect(formatElapsed(59_000)).toBe("59s");
        expect(formatElapsed(60_000)).toBe("1m 0s");
        expect(formatElapsed(3_600_000)).toBe("1h 0m");
        expect(formatElapsed(3_723_000)).toBe("1h 2m");
    });

    it("floors rather than rounding, so an uptime never reads ahead of itself", () => {
        expect.assertions(2);

        expect(formatElapsed(999)).toBe("0s");
        expect(formatElapsed(59_999)).toBe("59s");
    });
});

describe("hitRate", () => {
    it("renders the share of hits to one decimal place", () => {
        expect.assertions(3);

        expect(hitRate(1, 1)).toBe("50.0%");
        expect(hitRate(3, 1)).toBe("75.0%");
        expect(hitRate(0, 4)).toBe("0.0%");
    });

    it("reads as an em-dash when the cache has seen nothing", () => {
        expect.assertions(1);

        // Distinct from "0.0%", which would claim the cache is missing everything.
        expect(hitRate(0, 0)).toBe("—");
    });
});
