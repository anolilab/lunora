import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { EnrichedQueryStat } from "../../../src/features/reports/metrics-aggregate";
import { QueryInsights } from "../../../src/features/reports/query-insights";

const makeStat = (over: Partial<EnrichedQueryStat> & { normalizedSql: string }): EnrichedQueryStat => {
    return {
        avgDurationMs: 0,
        execCount: 1,
        rowsRead: 0,
        rowsWritten: 0,
        totalDurationMs: 0,
        ...over,
        normalizedSql: over.normalizedSql,
    };
};

const EMPTY: EnrichedQueryStat[] = [];

const ONE_STAT = [makeStat({ avgDurationMs: 10, execCount: 5, normalizedSql: "SELECT * FROM t", totalDurationMs: 50 })];

const THREE_PERFORMANCE_STATS = [
    makeStat({ avgDurationMs: 120, normalizedSql: "SELECT * FROM a" }),
    makeStat({ avgDurationMs: 75, normalizedSql: "SELECT * FROM b" }),
    makeStat({ avgDurationMs: 5, normalizedSql: "SELECT * FROM c" }),
];

const THREE_ROWS = [
    makeStat({ avgDurationMs: 10, normalizedSql: "SELECT * FROM a" }),
    makeStat({ avgDurationMs: 20, normalizedSql: "SELECT * FROM b" }),
    makeStat({ avgDurationMs: 30, normalizedSql: "SELECT * FROM c" }),
];

const ONE_EXPAND_STAT = [makeStat({ avgDurationMs: 10, execCount: 3, normalizedSql: "SELECT id FROM users WHERE id = ?" })];

const ONE_SORT_STAT = [makeStat({ avgDurationMs: 10, normalizedSql: "SELECT * FROM t" })];

describe("queryInsights", () => {
    it("shows empty state when queryStats is empty", () => {
        expect.assertions(1);

        render(<QueryInsights queryStats={EMPTY} />);

        expect(screen.getByTestId("qi-empty")).toBeDefined();
    });

    it("renders the leaderboard root when stats are present", () => {
        expect.assertions(1);

        render(<QueryInsights queryStats={ONE_STAT} />);

        expect(screen.getByTestId("qi-root")).toBeDefined();
    });

    it("counts critical, moderate, and fast queries from avgDurationMs", () => {
        expect.assertions(3);

        render(<QueryInsights queryStats={THREE_PERFORMANCE_STATS} />);

        expect(screen.getByTestId("qi-critical").textContent).toBe("1");
        expect(screen.getByTestId("qi-moderate").textContent).toBe("1");
        expect(screen.getByTestId("qi-fast").textContent).toBe("1");
    });

    it("renders one row per stat entry", () => {
        expect.assertions(1);

        render(<QueryInsights queryStats={THREE_ROWS} />);

        expect(screen.getAllByTestId("qi-row")).toHaveLength(3);
    });

    it("toggles expansion on row click", () => {
        expect.assertions(2);

        render(<QueryInsights queryStats={ONE_EXPAND_STAT} />);

        const row = screen.getAllByTestId("qi-row")[0]!;

        // Initially collapsed — "Full statement" not visible.
        expect(screen.queryByText("Full statement")).toBeNull();

        // Click the expand button — it's the first (and only) button inside the row.
        fireEvent.click(within(row).getByRole("button"));

        expect(screen.getByText("Full statement")).toBeDefined();
    });

    it("renders the sort control", () => {
        expect.assertions(1);

        render(<QueryInsights queryStats={ONE_SORT_STAT} />);

        expect(screen.getByTestId("qi-sort")).toBeDefined();
    });
});
