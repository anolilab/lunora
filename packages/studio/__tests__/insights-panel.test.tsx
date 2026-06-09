import { CirrusProvider } from "@cirrus/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FunctionStatsResult, ShardMetrics } from "../src/admin";
import { ADMIN_FUNCTIONS } from "../src/admin";
import { InsightsPanel } from "../src/insights-panel";
import type { MockClientHooks } from "./mock-client";
import { createMockClient } from "./mock-client";

const HEALTHY: ShardMetrics = {
    cache: { bytes: 0, entries: 4, evictions: 0, hits: 90, misses: 10 },
    databaseSize: 1024,
    errors: 0,
    requests: 100,
    shard: "__root__",
    sinceMs: 1_700_000_000_000,
    uptimeMs: 1000,
};

const SLOW_STATS: FunctionStatsResult = {
    functions: [
        {
            calls: 3,
            errors: 0,
            lastCalledAt: 1000,
            lastErrorAt: null,
            lastErrorMessage: null,
            maxDurationMs: 4200,
            path: "reports:build",
            scannedTables: [],
            scans: 0,
            totalDurationMs: 9000,
        },
    ],
    sinceMs: 1_700_000_000_000,
};

/** A slow function whose latency is *explained* by a full scan of `posts` — drives the causal missing-index insight. */
const SCAN_STATS: FunctionStatsResult = {
    functions: [
        {
            calls: 3,
            errors: 0,
            lastCalledAt: 1000,
            lastErrorAt: null,
            lastErrorMessage: null,
            maxDurationMs: 4200,
            path: "feed:list",
            scannedTables: [{ scans: 9, table: "posts" }],
            scans: 9,
            totalDurationMs: 9000,
        },
    ],
    sinceMs: 1_700_000_000_000,
};

const EMPTY_STATS: FunctionStatsResult = { functions: [], sinceMs: 1_700_000_000_000 };

const createClient = (metrics: ShardMetrics, stats: FunctionStatsResult): MockClientHooks =>
    createMockClient({
        query: (reference): unknown => {
            if (reference === ADMIN_FUNCTIONS.getMetrics) {
                return metrics;
            }

            if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                return stats;
            }

            throw new Error(`unexpected ${reference}`);
        },
    });

const renderPanel = (mock: MockClientHooks) => (
    <CirrusProvider client={mock.asClient}>
        <InsightsPanel />
    </CirrusProvider>
);

describe("insightsPanel", () => {
    it("renders a detected slow-function insight on the Info tab", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(HEALTHY, SLOW_STATS)));

        // slow-function is info-severity — it lives under the Info tab.
        fireEvent.click(await screen.findByTestId("cirrus-insights-tab-info"));
        await screen.findByText("Slow function");

        const view = screen.getByTestId("cirrus-insights");

        expect(view.textContent).toContain("Slow function");
        expect(view.textContent).toContain("reports:build");
    });

    it("renders the causal missing-index chain on the Warnings tab, with an add-index jump", async () => {
        expect.assertions(4);

        render(renderPanel(createClient(HEALTHY, SCAN_STATS)));

        // missing-index is a warning — open the Warnings tab.
        fireEvent.click(await screen.findByTestId("cirrus-insights-tab-warning"));
        await screen.findByText("Missing index");

        const view = screen.getByTestId("cirrus-insights");

        expect(view.textContent).toContain("Missing index");
        // The function and the table it full-scanned.
        expect(view.textContent).toContain("feed:list");
        expect(view.textContent).toContain("full-scanned posts");

        // The "add the index" deep-link to the Schema/Indexes tab is present.
        const addIndex = await screen.findByTestId("in-add-index-posts");

        expect(addIndex.textContent).toContain("Add index on posts");
    });

    it("shows the per-tab empty state when nothing is wrong", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(HEALTHY, EMPTY_STATS)));

        const empty = await screen.findByTestId("cirrus-insights-empty");

        expect(empty.textContent).toContain("No errors detected");
    });

    it("still surfaces insights when one snapshot fails (best-effort)", async () => {
        expect.assertions(1);

        // getMetrics fails, getFunctionStats succeeds with a slow function — the
        // panel should still surface the function insight rather than blanking.
        const mock = createMockClient({
            query: (reference): unknown => {
                if (reference === ADMIN_FUNCTIONS.getFunctionStats) {
                    return SLOW_STATS;
                }

                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        fireEvent.click(await screen.findByTestId("cirrus-insights-tab-info"));

        const cell = await screen.findByText("reports:build");

        expect(cell.textContent).toContain("reports:build");
    });

    it("surfaces an error only when both snapshots fail", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("cirrus-insights-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });
});
