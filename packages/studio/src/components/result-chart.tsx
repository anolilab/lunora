import type { ReactElement } from "react";

import { useT } from "../i18n/i18n-context";
import type { SqlConsoleResult } from "../lib/admin";
import { formatCell } from "../lib/internal";
import { Bar, EvilBarChart, Tooltip, XAxis } from "./evilcharts/charts/bar-chart";
import type { ChartConfig } from "./evilcharts/ui/chart";

/** Most bars rendered, so a large result stays readable (and the DOM bounded). */
const MAX_BARS = 50;

/** Single series keyed `value`, painted with the aurora-led chart ramp (Aurora Violet). */
const RESULT_CHART_CONFIG = { value: { colors: { dark: ["var(--chart-1)"], light: ["var(--chart-1)"] }, label: "value" } } satisfies ChartConfig;

/**
 * Choose the columns to chart: the first column whose values are all numbers is
 * the bar value; the first other column is the label (falling back to the row
 * index). Returns `null` for `value` when nothing numeric is present.
 */
const pickColumns = (result: SqlConsoleResult): { label: null | string; value: null | string } => {
    const value = result.columns.find((column) => result.rows.length > 0 && result.rows.every((row) => typeof row[column] === "number")) ?? null;
    const label = result.columns.find((column) => column !== value) ?? null;

    return { label, value };
};

/**
 * A bar chart of a SQL result — the first numeric column plotted against the
 * first label column (or the row index), rendered with evilcharts (Recharts).
 * Capped at {@link MAX_BARS} rows; shows a hint when the result has no numeric
 * column to plot.
 */
const SqlResultChart = ({ axes, result }: { readonly axes?: { x: string; y: string[] }; readonly result: SqlConsoleResult }): ReactElement => {
    const t = useT();
    const picked = pickColumns(result);
    // A set, not repeated `columns.includes`: the `y` scan below is a lookup per
    // candidate, and a wide result makes that quadratic on every render.
    const present = new Set(result.columns);
    // A model-suggested pair overrides the heuristic, but only for columns the
    // result actually has — `axes` is already validated server-side, and this is
    // the second gate so a stale suggestion cannot blank the chart.
    const label = axes !== undefined && present.has(axes.x) ? axes.x : picked.label;
    const value = axes?.y.find((column) => present.has(column)) ?? picked.value;

    const data =
        value === null
            ? []
            : result.rows.slice(0, MAX_BARS).map((row, index) => {
                  return {
                      label: label === null ? `#${(index + 1).toString()}` : formatCell(row[label]),
                      value: Number(row[value]) || 0,
                  };
              });

    if (value === null) {
        return (
            <p className="p-4 text-sm text-muted-foreground" data-testid="sql-chart-empty">
                {t("No numeric column to chart.")}
            </p>
        );
    }

    return (
        <div className="h-80 w-full p-3" data-testid="sql-chart">
            <EvilBarChart className="h-full w-full" config={RESULT_CHART_CONFIG} data={data}>
                <XAxis dataKey="label" />
                <Bar dataKey="value" />
                <Tooltip />
            </EvilBarChart>
        </div>
    );
};

export default SqlResultChart;
