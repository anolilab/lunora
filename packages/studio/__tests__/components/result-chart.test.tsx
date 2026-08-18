import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import SqlResultChart from "../../src/components/result-chart";
import type { SqlConsoleResult } from "../../src/lib/admin";

/** A two-column result: an ordered label and a numeric series to plot. */
const RESULT: SqlConsoleResult = {
    columns: ["day", "total"],
    rows: [
        { day: "2026-07-01", total: 3 },
        { day: "2026-07-02", total: 7 },
    ],
    rowCount: 2,
    truncated: false,
};

describe("sqlResultChart", () => {
    it("defaults to a bar chart when nothing was inferred", () => {
        expect.assertions(1);

        render(<SqlResultChart result={RESULT} />);

        expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe("bar");
    });

    it.each(["area", "line"] as const)("renders an inferred %s chart as that shape", (kind) => {
        expect.assertions(1);

        render(<SqlResultChart axes={{ kind, x: "day", y: ["total"] }} result={RESULT} />);

        // The whole point of inferring a kind: a suggestion of "line" that came
        // back as bars is a suggestion silently dropped.
        expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe(kind);
    });

    it("falls back to bars when the suggested series is not in the result", () => {
        expect.assertions(1);

        render(<SqlResultChart axes={{ kind: "line", x: "day", y: ["revenue"] }} result={RESULT} />);

        // The columns fell back to the heuristic, so the shape does too: a line
        // through columns the model never saw asserts an order nothing verified.
        expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe("bar");
    });

    it.each(["area", "line"] as const)("draws a chosen %s chart with nothing inferred at all", (kind) => {
        expect.assertions(1);

        render(<SqlResultChart kind={kind} result={RESULT} />);

        // The picker's whole job. With no `axes` the heuristic supplies the
        // columns, and before this the shape was hard-wired to "bar".
        expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe(kind);
    });

    it("keeps the chosen shape when the suggested series is missing", () => {
        expect.assertions(1);

        // The suggestion's series is absent, so its SHAPE is discarded — but the
        // operator's is not: they asserted the ordering themselves.
        render(<SqlResultChart axes={{ kind: "bar", x: "day", y: ["revenue"] }} kind="line" result={RESULT} />);

        expect(screen.getByTestId("sql-chart").dataset["chartKind"]).toBe("line");
    });

    it("shows the empty state when no column is numeric", () => {
        expect.assertions(1);

        render(<SqlResultChart result={{ columns: ["day"], rowCount: 1, rows: [{ day: "2026-07-01" }], truncated: false }} />);

        expect(screen.getByTestId("sql-chart-empty")).toBeDefined();
    });
});
