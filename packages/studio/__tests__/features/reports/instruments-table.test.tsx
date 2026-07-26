import { LunoraProvider } from "@lunora/react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatMetricValue, metricHeadline } from "../../../src/features/reports/instrument-format";
import { InstrumentsTable } from "../../../src/features/reports/instruments-table";
import type { MetricHistoryResult, MetricSeries } from "../../../src/lib/admin";
import { ADMIN_FUNCTIONS } from "../../../src/lib/admin";
import type { MockClientHooks } from "../../mock-client";
import { createMockClient } from "../../mock-client";

const SERIES: MetricSeries[] = [
    {
        count: 5,
        exemplarTraceId: "trace-checkout-42",
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

/** Two-bucket history for orders.placed so the trend sparkline (needs ≥2 points) renders. */
const HISTORY: MetricHistoryResult = {
    series: [
        {
            functionPath: "orders:checkout",
            kind: "counter",
            name: "orders.placed",
            points: [
                { bucketMs: 1_700_000_000_000, count: 3, last: 1, max: 1, min: 1, sum: 3 },
                { bucketMs: 1_700_000_060_000, count: 5, last: 1, max: 1, min: 1, sum: 5 },
            ],
        },
    ],
};

const createClient = (result: unknown = DEFAULT_RESULT, history: unknown = HISTORY): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetricSeries) {
                return result;
            }

            if (reference === ADMIN_FUNCTIONS.getMetricHistory) {
                return history;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderTable = (mock: MockClientHooks, onOpenTrace?: (traceId: string) => void) => (
    <LunoraProvider client={mock.asClient}>
        <InstrumentsTable onOpenTrace={onOpenTrace} shardKey="" />
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

    it("surfaces an RPC error as a muted notice instead of vanishing", async () => {
        expect.assertions(2);

        // A stale admin token / permission failure must not be indistinguishable
        // from "no custom metrics" — the section renders a one-line notice, not null.
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getMetricSeries) {
                    throw new Error("admin token expired");
                }

                if (reference === ADMIN_FUNCTIONS.getMetricHistory) {
                    return { series: [] };
                }

                throw new Error(`unexpected ${reference}`);
            },
        });

        render(renderTable(mock));

        const notice = await screen.findByTestId("mt-instruments-error");

        expect(notice).toBeDefined();
        expect(notice.textContent).toContain("admin token expired");
    });

    it("draws a trend sparkline for a series that has ≥2 durable history buckets", async () => {
        expect.assertions(1);

        render(renderTable(createClient()));

        // orders.placed has two history buckets; the sparkline renders for it.
        await expect(screen.findByTestId("mt-instrument-trend-orders.placed")).resolves.toBeDefined();
    });

    it("joins live series to history by canonical key, regardless of attribute order", async () => {
        expect.assertions(1);

        // The live series carries attributes in caller order; the durable history
        // round-trips them through the server's sort. A key-order-sensitive join
        // would miss and blank the sparkline — this guards the canonical-key fix.
        const live: MetricSeries[] = [
            {
                // Caller-insertion order: route first.
                attributes: { route: "/a", method: "GET" },
                count: 9,
                firstTs: 1_700_000_000_000,
                functionPath: "api:handle",
                kind: "counter",
                last: 1,
                lastTs: 1_700_000_005_000,
                max: 1,
                min: 1,
                name: "http.requests",
                sum: 9,
            },
        ];
        const history: MetricHistoryResult = {
            series: [
                {
                    // Sorted order, as stableStringify → JSON.parse returns it.
                    attributes: { method: "GET", route: "/a" },
                    functionPath: "api:handle",
                    kind: "counter",
                    name: "http.requests",
                    points: [
                        { bucketMs: 1_700_000_000_000, count: 4, last: 1, max: 1, min: 1, sum: 4 },
                        { bucketMs: 1_700_000_060_000, count: 5, last: 1, max: 1, min: 1, sum: 5 },
                    ],
                },
            ],
        };

        render(renderTable(createClient({ series: live }, history)));

        await expect(screen.findByTestId("mt-instrument-trend-http.requests")).resolves.toBeDefined();
    });

    it("links a series' exemplar trace and opens it on click", async () => {
        expect.assertions(2);

        const opened: string[] = [];

        render(renderTable(createClient(), (traceId) => opened.push(traceId)));

        const link = await screen.findByTestId("mt-instrument-trace-orders.placed");

        // The short id is shown; the full id is what the drill-down opens.
        expect(link.textContent).toBe("trace-ch");

        fireEvent.click(link);

        expect(opened).toStrictEqual(["trace-checkout-42"]);
    });
});
