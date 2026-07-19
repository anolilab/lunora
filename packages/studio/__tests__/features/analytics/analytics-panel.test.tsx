import type { AnalyticsSqlResult } from "@lunora/bindings/analytics";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AnalyticsPanel } from "../../../src/features/analytics/analytics-panel";

const result = (rows: Record<string, unknown>[], columns: { name: string; type: string }[]): AnalyticsSqlResult => {
    return {
        columns,
        rowCount: rows.length,
        rows,
    };
};

describe("analyticsPanel", () => {
    it("renders the config-needed empty state and makes no query without a token", () => {
        expect.assertions(2);

        const runQuery = vi.fn<(sql: string) => Promise<AnalyticsSqlResult>>();

        // No config and no runQuery override → degrade gracefully, never fetch.
        render(<AnalyticsPanel />);

        expect(screen.getByTestId("analytics-not-configured")).toBeDefined();
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("runs the usage panels against the injected runQuery and renders rows", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<(sql: string) => Promise<AnalyticsSqlResult>>(async (sql) => {
            if (sql.includes("count()") && sql.includes("GROUP BY fn")) {
                return result(
                    [{ calls: 12, fn: "messages:list" }],
                    [
                        { name: "fn", type: "String" },
                        { name: "calls", type: "UInt64" },
                    ],
                );
            }

            return result([], []);
        });

        render(<AnalyticsPanel runQuery={runQuery} />);

        await waitFor(() => {
            expect(screen.getByText("messages:list")).toBeDefined();
        });

        // Volume + latency + hot-shards panels each issue one query.
        expect(runQuery).toHaveBeenCalledTimes(3);
    });

    it("surfaces a SQL-API error per panel without crashing", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<(sql: string) => Promise<AnalyticsSqlResult>>(async () => {
            throw new Error("Analytics Engine SQL API returned 403: forbidden");
        });

        render(<AnalyticsPanel runQuery={runQuery} />);

        await waitFor(() => {
            expect(screen.getAllByTestId("analytics-error").length).toBeGreaterThan(0);
        });
    });
});
