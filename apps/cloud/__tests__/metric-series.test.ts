import { describe, expect, it } from "vitest";

import { foldMetricSeries } from "../src/telemetry/metric-series";

describe(foldMetricSeries, () => {
    it("averages every point in a bucket (exact, not sampled)", () => {
        const points = [
            { at: 1000, kind: "gauge", name: "cpu", value: 10 },
            { at: 1500, kind: "gauge", name: "cpu", value: 20 }, // same 10s bucket as above
            { at: 12_000, kind: "gauge", name: "cpu", value: 30 }, // next bucket
        ];

        const [series] = foldMetricSeries(points, { bucketMs: 10_000 });

        expect(series?.name).toBe("cpu");
        expect(series?.points).toStrictEqual([
            { t: 0, value: 15 }, // (10 + 20) / 2 — both points averaged, not one sampled
            { t: 10_000, value: 30 },
        ]);
        expect(series).toMatchObject({ firstValue: 15, lastValue: 30, trend: 15 });
    });

    it("separates series by name | kind | functionPath", () => {
        const points = [
            { at: 0, kind: "gauge", name: "a", value: 1 },
            { at: 0, kind: "sum", name: "a", value: 2 },
            { at: 0, functionPath: "orders:list", kind: "gauge", name: "a", value: 3 },
        ];

        expect(foldMetricSeries(points, { bucketMs: 1000 })).toHaveLength(3);
    });

    it("orders buckets oldest→newest regardless of input order", () => {
        const points = [
            { at: 30_000, kind: "gauge", name: "m", value: 3 },
            { at: 10_000, kind: "gauge", name: "m", value: 1 },
            { at: 20_000, kind: "gauge", name: "m", value: 2 },
        ];

        const [series] = foldMetricSeries(points, { bucketMs: 10_000 });

        expect(series?.points.map((point) => point.value)).toStrictEqual([1, 2, 3]);
        expect(series).toMatchObject({ firstValue: 1, lastValue: 3 });
    });

    it("skips empty-name and non-finite points", () => {
        const points = [
            { at: 0, kind: "gauge", name: "", value: 1 },
            { at: 0, kind: "gauge", name: "x", value: Number.NaN },
            { at: Number.POSITIVE_INFINITY, kind: "gauge", name: "x", value: 5 },
        ];

        expect(foldMetricSeries(points)).toStrictEqual([]);
    });
});
