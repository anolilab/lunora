import { describe, expect, it } from "vitest";

import { buildMetricSeriesQuery, foldMetricRows, MAX_METRIC_SERIES } from "../src/telemetry/metrics-read";

describe(buildMetricSeriesQuery, () => {
    it("buckets by the given width, scopes to the org, and bounds the window", () => {
        const sql = buildMetricSeriesQuery({ bucketSec: 900, dataset: "TELEMETRY", organizationId: "org_1", sinceSec: 1000, toSec: 2000 });

        expect(sql).toContain("intDiv(toUInt32(timestamp), 900) * 900 AS bucket");
        expect(sql).toContain("FROM TELEMETRY");
        expect(sql).toContain("timestamp > toDateTime(1000)");
        expect(sql).toContain("timestamp <= toDateTime(2000)");
        expect(sql).toContain("blob4 = 'org_1'");
        expect(sql).toContain("GROUP BY name, kind, functionPath, bucket");
    });

    it("omits the upper bound when `toSec` is absent and escapes the org id", () => {
        const sql = buildMetricSeriesQuery({ bucketSec: 60, dataset: "TELEMETRY", organizationId: "o'1", sinceSec: 5 });

        expect(sql).not.toContain("timestamp <=");
        expect(sql).toContain("blob4 = 'o''1'");
    });
});

describe(foldMetricRows, () => {
    it("folds rows into per-metric series with ms buckets, last value, and net trend", () => {
        const series = foldMetricRows([
            { bucket: "1000", functionPath: "messages:send", kind: "counter", name: "sent", value: "2" },
            { bucket: "1900", functionPath: "messages:send", kind: "counter", name: "sent", value: "5" },
            { bucket: "1000", functionPath: "", kind: "gauge", name: "queue_depth", value: "10" },
        ]);

        expect(series).toHaveLength(2);

        const sent = series.find((entry) => entry.name === "sent");

        expect(sent).toMatchObject({ firstValue: 2, kind: "counter", lastValue: 5, trend: 3 });
        // epoch seconds → ms.
        expect(sent?.points).toStrictEqual([
            { t: 1_000_000, value: 2 },
            { t: 1_900_000, value: 5 },
        ]);

        const gauge = series.find((entry) => entry.name === "queue_depth");

        expect(gauge?.functionPath).toBeUndefined();
        expect(gauge?.trend).toBe(0);
    });

    it("skips nameless rows and caps the distinct series", () => {
        const rows = [{ bucket: "0", kind: "counter", name: "", value: "1" }];

        for (let index = 0; index < MAX_METRIC_SERIES + 10; index += 1) {
            rows.push({ bucket: "0", kind: "counter", name: `m_${String(index)}`, value: "1" });
        }

        const series = foldMetricRows(rows);

        expect(series).toHaveLength(MAX_METRIC_SERIES);
        expect(series.every((entry) => entry.name !== "")).toBe(true);
    });
});
