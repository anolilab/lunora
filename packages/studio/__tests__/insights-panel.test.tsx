import { CirrusProvider } from "@cirrus/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { FunctionStatsResult, ShardMetrics } from "../src/admin.js";
import { ADMIN_FUNCTIONS } from "../src/admin.js";
import { InsightsPanel } from "../src/insights-panel.js";
import type { MockClientHooks } from "./mock-client.js";
import { createMockClient } from "./mock-client.js";

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
    it("renders a detected slow-function insight from the two snapshots", async () => {
        expect.assertions(2);

        render(renderPanel(createClient(HEALTHY, SLOW_STATS)));

        const list = await screen.findByTestId("in-list");

        expect(list.textContent).toContain("Slow function");
        expect(list.textContent).toContain("reports:build");
    });

    it("renders the causal missing-index chain naming the scanned table, with an add-index jump", async () => {
        expect.assertions(4);

        render(renderPanel(createClient(HEALTHY, SCAN_STATS)));

        const list = await screen.findByTestId("in-list");

        // Causal headline + the function and the table it full-scanned.
        expect(list.textContent).toContain("Missing index");
        expect(list.textContent).toContain("feed:list");
        expect(list.textContent).toContain("full-scanned posts");

        // The "add the index" deep-link to the Schema/Indexes tab is present.
        expect(await screen.findByTestId("in-add-index-posts")).toBeTruthy();
    });

    it("shows the empty state when nothing is wrong", async () => {
        expect.assertions(1);

        render(renderPanel(createClient(HEALTHY, EMPTY_STATS)));

        const empty = await screen.findByTestId("in-empty");

        expect(empty.textContent).toContain("No issues detected.");
    });

    it("still renders insights when one snapshot fails (best-effort)", async () => {
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

        const list = await screen.findByTestId("in-list");

        expect(list.textContent).toContain("reports:build");
    });

    it("surfaces an error only when both snapshots fail", async () => {
        expect.assertions(1);

        const mock = createMockClient({
            query: () => {
                throw new Error("ADMIN_FORBIDDEN");
            },
        });

        render(renderPanel(mock));

        const error = await screen.findByTestId("in-error");

        expect(error.textContent).toBe("ADMIN_FORBIDDEN");
    });
});
