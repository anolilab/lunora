import type { AnalyticsSqlResult } from "@lunora/bindings/analytics";
import type { AnalyticsSqlParams, AnalyticsSqlQueryResult } from "@lunora/bindings/analytics-sql";
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
    it("renders the not-wired empty state and makes no query without a runner", () => {
        expect.assertions(2);

        const runQuery = vi.fn<(sql: string) => Promise<AnalyticsSqlResult>>();

        // No runQuery → degrade gracefully, never fetch.
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

    it("prefers the binding-backed runner and speaks the Analytics SQL dialect with a $since bound", async () => {
        expect.hasAssertions();

        const runQuery = vi.fn<(sql: string) => Promise<AnalyticsSqlResult>>();
        const runAnalyticsSql = vi.fn<(sql: string, params?: AnalyticsSqlParams) => Promise<AnalyticsSqlQueryResult>>(async (sql) => {
            if (sql.includes("COUNT(*) AS calls") && sql.includes("GROUP BY fn")) {
                return { rowCount: 1, rows: [{ calls: 7, fn: "messages:send" }] };
            }

            return { rowCount: 0, rows: [] };
        });

        render(<AnalyticsPanel dataset="APP_EVENTS" runAnalyticsSql={runAnalyticsSql} runQuery={runQuery} />);

        await waitFor(() => {
            expect(screen.getByText("messages:send")).toBeDefined();
        });

        // Columns come from the row's keys, since the binding returns no metadata.
        expect(screen.getByText("calls")).toBeDefined();
        expect(runAnalyticsSql).toHaveBeenCalledTimes(3);
        expect(runQuery).not.toHaveBeenCalled();

        const [sql, params] = runAnalyticsSql.mock.calls[0]!;

        expect(sql).toContain('FROM events.analyticsEngine."APP_EVENTS" WHERE timestamp >= $since');
        expect(Number.isNaN(Date.parse((params as { since: string }).since))).toBe(false);
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
