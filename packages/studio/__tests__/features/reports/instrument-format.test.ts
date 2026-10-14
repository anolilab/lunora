import { describe, expect, it } from "vitest";

import { formatMetricValue, metricHeadline, pointValue, seriesMatchKey } from "../../../src/features/reports/instrument-format";
import type { MetricHistoryPoint, MetricSeries } from "../../../src/lib/admin";

const series = (overrides: Partial<MetricSeries> = {}): MetricSeries => {
    return {
        count: 4,
        firstTs: 1,
        functionPath: "orders:place",
        kind: "counter",
        last: 7,
        lastTs: 2,
        max: 9,
        min: 1,
        name: "orders.placed",
        sum: 20,
        ...overrides,
    };
};

const point = (overrides: Partial<MetricHistoryPoint> = {}): MetricHistoryPoint => {
    return {
        bucketMs: 1_700_000_000_000,
        count: 4,
        last: 7,
        max: 9,
        min: 1,
        sum: 20,
        ...overrides,
    };
};

describe("seriesMatchKey", () => {
    it("is independent of attribute key order so the live/history join never misses", () => {
        expect.assertions(1);

        // The live series carries attributes in insertion order; the history round-trips
        // them through the server's code-point-sorted stableStringify. A key-order-sensitive
        // encoder would place these under different keys and blank the trend.
        const a = seriesMatchKey("counter", "http.requests", { method: "GET", route: "/a" });
        const b = seriesMatchKey("counter", "http.requests", { route: "/a", method: "GET" });

        expect(a).toBe(b);
    });

    it("treats absent attributes as an empty dimension set", () => {
        expect.assertions(1);

        expect(seriesMatchKey("gauge", "cpu", undefined)).toBe(seriesMatchKey("gauge", "cpu", {}));
    });

    it("distinguishes different kinds, names, and dimensions", () => {
        expect.assertions(3);

        expect(seriesMatchKey("counter", "x", {})).not.toBe(seriesMatchKey("gauge", "x", {}));
        expect(seriesMatchKey("counter", "x", {})).not.toBe(seriesMatchKey("counter", "y", {}));
        expect(seriesMatchKey("counter", "x", { a: 1 })).not.toBe(seriesMatchKey("counter", "x", { a: 2 }));
    });
});

describe("metricHeadline (per-kind projection of a live series)", () => {
    it("projects a gauge to its current reading", () => {
        expect.assertions(1);

        expect(metricHeadline(series({ kind: "gauge", last: 42, sum: 999 }))).toBe(42);
    });

    it("projects a counter to its running total", () => {
        expect.assertions(1);

        expect(metricHeadline(series({ kind: "counter", sum: 20 }))).toBe(20);
    });

    it("projects a histogram to its mean", () => {
        expect.assertions(1);

        expect(metricHeadline(series({ kind: "histogram", count: 4, sum: 20 }))).toBe(5);
    });

    it("floors a histogram's sample count at 1 so an empty histogram never divides by zero", () => {
        expect.assertions(1);

        expect(metricHeadline(series({ kind: "histogram", count: 0, sum: 7 }))).toBe(7);
    });
});

describe("pointValue (per-kind projection of a history bucket)", () => {
    it("projects a history bucket with the same per-kind rule as the headline", () => {
        expect.assertions(3);

        expect(pointValue("gauge", point({ last: 3 }))).toBe(3);
        expect(pointValue("counter", point({ sum: 20 }))).toBe(20);
        expect(pointValue("histogram", point({ count: 5, sum: 10 }))).toBe(2);
    });
});

describe("formatMetricValue", () => {
    it("formats an integer as a grouped integer with no fractional digits", () => {
        expect.assertions(1);

        // Compare against the same locale call the source uses so the assertion is
        // locale-robust; the branch under test is "integer → grouped integer".
        expect(formatMetricValue(1_234_567)).toBe((1_234_567).toLocaleString());
    });

    it("rounds a fractional value to at most two decimals", () => {
        expect.assertions(2);

        const formatted = formatMetricValue(3.141_59);

        expect(formatted).toBe((3.141_59).toLocaleString(undefined, { maximumFractionDigits: 2 }));
        // At most two fractional digits (locale-agnostic separator).
        expect(formatted).toMatch(/^\d+[.,]\d{1,2}$/u);
    });
});
