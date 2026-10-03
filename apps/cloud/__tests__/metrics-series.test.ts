import { describe, expect, it } from "vitest";

import { buildMetricSeriesQuery, foldMetricRows, MAX_METRIC_SERIES } from "../src/telemetry/metrics-read";

describe(buildMetricSeriesQuery, () => {
    it("buckets by the given width, scopes to the org, and bounds the window", () => {
        const { params, query } = buildMetricSeriesQuery({ bucketSec: 900, dataset: "TELEMETRY", organizationId: "org_1", sinceSec: 1000, toSec: 2000 });

        expect(query).toContain("toUnixTimestamp(toStartOfInterval(timestamp, INTERVAL '900' SECOND)) AS bucket");
        expect(query).toContain('FROM events.analyticsEngine."TELEMETRY"');
        expect(query).toContain("AVG(double1) AS value");
        expect(query).toContain("timestamp > $since");
        expect(query).toContain("timestamp <= $to");
        expect(query).toContain("blob4 = $organizationId");
        expect(query).toContain("GROUP BY name, kind, functionPath, bucket");
        expect(params).toStrictEqual({ organizationId: "org_1", since: "1970-01-01T00:16:40Z", to: "1970-01-01T00:33:20Z" });
    });

    /** The org id is a bound value: a quote in it can never reach the SQL text. */
    it("omits the upper bound when `toSec` is absent and binds the org id rather than splicing it", () => {
        const { params, query } = buildMetricSeriesQuery({ bucketSec: 60, dataset: "TELEMETRY", organizationId: "o'1", sinceSec: 5 });

        expect(query).not.toContain("timestamp <=");
        expect(query).not.toContain("o'1");
        expect(params).toStrictEqual({ organizationId: "o'1", since: "1970-01-01T00:00:05Z" });
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
