import type { ReactElement } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, XAxis as RechartsXAxis } from "recharts";

import { useT } from "../i18n/i18n-context";
import type { AssistantChartConfig, SqlConsoleResult } from "../lib/admin";
import { formatCell } from "../lib/internal";
import { Bar, EvilBarChart, Tooltip, XAxis } from "./evilcharts/charts/bar-chart";
import type { ChartConfig } from "./evilcharts/ui/chart";
import { ChartContainer } from "./evilcharts/ui/chart";
import { ChartTooltip, ChartTooltipContent } from "./evilcharts/ui/tooltip";

/** Most points rendered, so a large result stays readable (and the DOM bounded). */
const MAX_BARS = 50;

/** Single series keyed `value`, painted with the aurora-led chart ramp (Aurora Violet). */
const RESULT_CHART_CONFIG = { value: { colors: { dark: ["var(--chart-1)"], light: ["var(--chart-1)"] }, label: "value" } } satisfies ChartConfig;

/**
 * One plotted point: a formatted label and the numeric value behind it.
 *
 * A type alias rather than an interface: `EvilBarChart`'s `data` is constrained
 * to a record of unknown values, and an interface has no implicit index
 * signature to satisfy that constraint.
 */
type ChartPoint = { label: string; value: number };

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
 * The line/area readings, drawn straight on Recharts inside the shared
 * {@link ChartContainer}.
 *
 * Not an evilcharts component: that library ships a bar chart only, and the
 * inferred `kind` has to mean something — a model that answers "line" and gets
 * bars back is a suggestion silently dropped. The container supplies the same
 * palette CSS variables, axis typography, and tooltip the bar path gets, so the
 * three kinds read as one chart with three shapes rather than two chart systems.
 */
const ContinuousChart = ({ data, kind }: { readonly data: ChartPoint[]; readonly kind: "area" | "line" }): ReactElement => {
    // `--color-<key>-<index>`, the variable `ChartStyle` emits for a config
    // entry's first colour — the same one the bar path paints with.
    const stroke = "var(--color-value-0)";

    return (
        <ChartContainer className="h-full w-full" config={RESULT_CHART_CONFIG}>
            {kind === "area" ? (
                <AreaChart data={data}>
                    <CartesianGrid vertical={false} />
                    <RechartsXAxis axisLine={false} dataKey="label" tickLine={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Area dataKey="value" fill={stroke} fillOpacity={0.2} stroke={stroke} type="monotone" />
                </AreaChart>
            ) : (
                <LineChart data={data}>
                    <CartesianGrid vertical={false} />
                    <RechartsXAxis axisLine={false} dataKey="label" tickLine={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line dataKey="value" dot={false} stroke={stroke} strokeWidth={2} type="monotone" />
                </LineChart>
            )}
        </ChartContainer>
    );
};

/**
 * A chart of a SQL result — the first numeric column plotted against the first
 * label column (or the row index), rendered with evilcharts (Recharts). Capped
 * at {@link MAX_BARS} rows; shows a hint when the result has no numeric column
 * to plot.
 *
 * `axes.kind` selects the shape when the assistant inferred one; a heuristic
 * chart (no `axes`) is always a bar chart, which is the reading that needs the
 * fewest assumptions about the x axis being ordered.
 */
const SqlResultChart = ({ axes, result }: { readonly axes?: AssistantChartConfig; readonly result: SqlConsoleResult }): ReactElement => {
    const t = useT();
    const picked = pickColumns(result);
    // A set, not repeated `columns.includes`: the `y` scan below is a lookup per
    // candidate, and a wide result makes that quadratic on every render.
    const present = new Set(result.columns);
    // A model-suggested pair overrides the heuristic, but only for columns the
    // result actually has — `axes` is already validated server-side, and this is
    // the second gate so a stale suggestion cannot blank the chart.
    const label = axes !== undefined && present.has(axes.x) ? axes.x : picked.label;
    const suggestedValue = axes?.y.find((column) => present.has(column));
    const value = suggestedValue ?? picked.value;

    const data: ChartPoint[] =
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

    // The suggested SHAPE only applies when the suggested SERIES survived the
    // gate above. A result the suggestion did not fit falls back to the heuristic
    // columns, and a line drawn through columns the model never saw asserts an
    // ordering nothing has established — so that case stays a bar chart.
    const kind = axes !== undefined && suggestedValue !== undefined ? axes.kind : "bar";

    return (
        // The kind is stamped on the wrapper because Recharts draws into a
        // measured container, which is 0×0 under jsdom — the shape is otherwise
        // unassertable, and "the suggestion was applied" is exactly the thing
        // that regressed.
        <div className="h-80 w-full p-3" data-chart-kind={kind} data-testid="sql-chart">
            {kind === "bar" ? (
                <EvilBarChart className="h-full w-full" config={RESULT_CHART_CONFIG} data={data}>
                    <XAxis dataKey="label" />
                    <Bar dataKey="value" />
                    <Tooltip />
                </EvilBarChart>
            ) : (
                <ContinuousChart data={data} kind={kind} />
            )}
        </div>
    );
};

export default SqlResultChart;
