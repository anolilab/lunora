import { LunoraProvider } from "@lunora/react";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatMetricValue, metricHeadline } from "../../../src/features/reports/instrument-format";
import { InstrumentsTable } from "../../../src/features/reports/instruments-table";
import type { MetricSeries } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SERIES: MetricSeries[] = [
    {
        count: 5,
        firstTs: 1_700_000_000_000,
        functionPath: "orders:checkout",
        kind: "counter",
        last: 3,
        lastTs: 1_700_000_005_000,
        max: 3,
        min: 1,
        name: "orders.placed",
        sum: 12,
    },
    {
        attributes: { region: "eu" },
        count: 4,
        firstTs: 1_700_000_000_000,
        functionPath: "orders:checkout",
        kind: "gauge",
        last: 7,
        lastTs: 1_700_000_006_000,
        max: 9,
        min: 2,
        name: "cart.items",
        sum: 20,
    },
    {
        count: 4,
        firstTs: 1_700_000_000_000,
        functionPath: "orders:checkout",
        kind: "histogram",
        last: 40,
        lastTs: 1_700_000_007_000,
        max: 100,
        min: 10,
        name: "checkout.ms",
        sum: 200,
    },
];

const DEFAULT_RESULT: unknown = { series: SERIES };

const createClient = (result: unknown = DEFAULT_RESULT): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetricSeries) {
                return result;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderTable = (mock: MockClientHooks) => (
    <LunoraProvider client={mock.asClient}>
        <InstrumentsTable shardKey="" />
    </LunoraProvider>
);

describe("metricHeadline", () => {
    it("projects the value each kind headlines with", () => {
        expect.assertions(3);

        // counter → running total, gauge → current reading, histogram → mean.
        expect(metricHeadline(SERIES[0] as MetricSeries)).toBe(12);
        expect(metricHeadline(SERIES[1] as MetricSeries)).toBe(7);
        expect(metricHeadline(SERIES[2] as MetricSeries)).toBe(50);
    });

    it("floors a histogram's sample count so an empty series never divides by zero", () => {
        expect.assertions(1);

        const empty: MetricSeries = { ...(SERIES[2] as MetricSeries), count: 0, sum: 0 };

        expect(metricHeadline(empty)).toBe(0);
    });
});

describe("formatMetricValue", () => {
    it("groups integers and caps fractional values at two decimals", () => {
        expect.assertions(2);

        expect(formatMetricValue(12_345)).toBe((12_345).toLocaleString());
        expect(formatMetricValue(50.126)).toBe((50.13).toLocaleString());
    });
});

describe("instrumentsTable", () => {
    it("renders one row per series with its kind, headline value, and count", async () => {
        expect.assertions(4);

        render(renderTable(createClient()));

        const row = await screen.findByTestId("mt-instrument-orders.placed");

        expect(row.textContent).toContain("orders.placed");
        expect(row.textContent).toContain("Counter");
        // Counter headline is its running total (sum), not the last increment.
        expect(screen.getByTestId("mt-instrument-value-orders.placed").textContent).toBe("12");
        // Histogram headline is the mean: 200 / 4.
        expect(screen.getByTestId("mt-instrument-value-checkout.ms").textContent).toBe("50");
    });

    it("collapses a degenerate min===max range to a dash but shows a real spread", async () => {
        expect.assertions(2);

        render(renderTable(createClient()));

        // Counter always +1 → range 1–1 → dash (noise, not information).
        const counter = await screen.findByTestId("mt-instrument-orders.placed");
        // Histogram with real spread → "min–max".
        const histogram = screen.getByTestId("mt-instrument-checkout.ms");

        expect(counter.textContent).not.toContain("1–1");
        expect(histogram.textContent).toContain("10–100");
    });

    it("shows a series' dimensions and a placeholder when it has none", async () => {
        expect.assertions(2);

        render(renderTable(createClient()));

        const gauge = await screen.findByTestId("mt-instrument-cart.items");
        const counter = screen.getByTestId("mt-instrument-orders.placed");

        expect(gauge.textContent).toContain("region=eu");
        expect(counter.textContent).toContain("—");
    });

    it("renders nothing when the shard has recorded no instruments", async () => {
        expect.assertions(1);

        render(renderTable(createClient({ series: [] })));

        // The section is fully absent rather than an empty table, so an
        // uninstrumented app's Metrics page stays uncluttered.
        await waitFor(() => {
            expect(screen.queryByTestId("mt-instruments")).toBeNull();
        });
    });
});
