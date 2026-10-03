import type { AnalyticsSqlQueryResult, FunctionUsagePanel } from "@lunora/bindings/analytics-sql";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalyticsPanel } from "../../../src/features/analytics/analytics-panel";

type Runner = (panel: FunctionUsagePanel) => Promise<AnalyticsSqlQueryResult>;

describe("analyticsPanel", () => {
    it("renders the not-wired empty state and makes no query without a runner", () => {
        expect.assertions(2);

        const runQuery = vi.fn<Runner>();

        // No runQuery → degrade gracefully, never fetch.
        render(<AnalyticsPanel />);

        expect(screen.getByTestId("analytics-not-configured")).toBeDefined();
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("asks the runner for each panel by key, never with SQL, and renders the rows", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<Runner>(async (panel) => {
            if (panel === "volume") {
                return { rowCount: 1, rows: [{ fn: "messages:send", calls: 7 }] };
            }

            return { rowCount: 0, rows: [] };
        });

        render(<AnalyticsPanel runQuery={runQuery} />);

        await waitFor(() => {
            expect(screen.getByText("messages:send")).toBeDefined();
        });

        // Columns come from the row's keys, in SELECT order: the binding returns no metadata.
        expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toStrictEqual(["fn", "calls"]);
        expect(runQuery.mock.calls.map(([panel]) => panel)).toStrictEqual(["volume", "latency", "hotShards"]);
    });

    it("surfaces a query error per panel without crashing", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<Runner>(async () => {
            throw new Error("Analytics SQL query failed: 403 forbidden");
        });

        render(<AnalyticsPanel runQuery={runQuery} />);

        await waitFor(() => {
            expect(screen.getAllByTestId("analytics-error")).toHaveLength(3);
        });
    });
});
